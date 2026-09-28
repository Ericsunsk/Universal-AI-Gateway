// Rate Limiter
// 基于 KV 持久化层 seam 的统一限流入口与协议工具
import { hashString32Base36 } from "../core/scheduler.js";

/**
 * 统一限流入口：委托 KV 持久化层 seam 的 limit 方法
 *
 * @param {Object} kv - KV 存储实例
 * @param {string} key - 限流键（如 "user:123" 或 "ip:1.2.3.4"）
 * @param {Object} config - 限流配置 { capacity, refillRate, cost }
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number, retryAfter: number}>}
 */
export async function checkRateLimit(kv, key, config) {
  // limit 为窗口内配额上限（常量），用于 X-RateLimit-Limit 响应头；
  // 绝不能由 remaining 反推——桶耗尽时 remaining=0 会让客户端误判配额为 1。
  const limit = config?.capacity ?? 0;
  if (!kv || typeof kv.limit !== "function") {
    // KV 不可用或无限流能力时 fail-open
    return { allowed: true, remaining: limit, limit, resetAt: 0, retryAfter: 0 };
  }
  const result = await kv.limit(key, config);
  return { ...result, limit };
}

/**
 * 预设限流配置
 */
export const RATE_LIMIT_PRESETS = {
  // 严格限流：每分钟 10 次（适用于敏感操作）
  strict: { capacity: 10, refillRate: 10 / 60 },

  // 标准限流：每分钟 60 次（适用于普通 API）
  standard: { capacity: 60, refillRate: 60 / 60 },

  // 宽松限流：每分钟 300 次（适用于高频场景）
  relaxed: { capacity: 300, refillRate: 300 / 60 },

  // 管理员限流：每分钟 120 次（管理端点）
  admin: { capacity: 120, refillRate: 120 / 60 },

  // Burst 限流：容量 100，每秒补充 10 个（允许短时爆发）
  burst: { capacity: 100, refillRate: 10 },
};

// 限流键需要紧凑稳定键 → base36 字符串形态；实现收敛在 core/scheduler.js
// （该模块为无依赖 leaf，引入它不会把 logging/kv 拖进本模块）。
const hashString32 = hashString32Base36;

/**
 * 从请求提取限流键
 * 优先级：API Key > IP 地址
 *
 * @param {Request} request - 请求对象
 * @param {Object} principal - 认证主体
 * @returns {string} 限流键
 */
export function extractRateLimitKey(request, principal = null) {
  // 1. 已认证用户：使用 API Key 哈希（避免泄露密钥）
  if (principal?.rateLimitId) {
    return `key:${principal.rateLimitId}`;
  }
  if (principal?.name) {
    // L2 修复：此处是**无 rateLimitId** 时的回落路径（正常三条 auth 路径都会设 rateLimitId）。
    // 原用 32-bit FNV，生日界下约 77k 个不同 name 即碰撞 → 两个主体共享限流桶，
    // 一个可耗尽另一个的配额。改为对 name 做双 32-bit 拼接（64-bit 有效空间），
    // 在保持同步、无 crypto 依赖的前提下把碰撞概率降到可忽略。
    const hash = `${hashString32(principal.name)}${hashString32(`\u0000${principal.name}`)}`;
    return `key:${hash}`;
  }

  // 2. 未认证或匿名：使用 IP 地址
  //
  // 只信平台注入、客户端无法覆盖的头。此前用 x-real-ip / x-forwarded-for / cf-connecting-ip，
  // 三者均可由客户端任意伪造：攻击者每次请求轮换 x-real-ip 即令每请求落入不同限流桶，
  // 配额形同虚设；全部省略时又共挤 ip:unknown 单桶（自伤面）。
  // Vercel 会覆写 x-vercel-forwarded-for 且剥离客户端同名头，故以其为准。
  // XFF 取【最后一跳】：链首是客户端自称值，链尾才是边缘节点实测值。
  const ip = platformClientIp(request);

  return `ip:${ip}`;
}

// 平台可信的客户端 IP 提取。
// 顺序即信任度：
// 1. x-vercel-forwarded-for 由 Vercel 边缘注入且覆写客户端同名头，最可信；
// 2. cf-connecting-ip 由 Cloudflare 强保证覆盖（附带 cf-ray 校验边缘来源），防伪造且适配 CDN 反代；
// 3. 通用 XFF：取首跳作为客户端标识，避免多级反代（如 Cloudflare -> Render）将末跳代理节点当成客户端导致全网限流串桶；
// 全缺则并入 unknown 单桶。
export function platformClientIp(request) {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  if (vercel) {
    const last = vercel.split(",").pop()?.trim();
    if (last) return last;
  }

  const cfConnecting = request.headers.get("cf-connecting-ip");
  if (cfConnecting && (request.headers.get("cf-ray") || !request.headers.get("x-forwarded-for"))) {
    return cfConnecting.trim();
  }

  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }

  return "unknown";
}

/**
 * 构造 429 限流响应
 *
 * @param {Object} result - checkRateLimit 返回结果 { allowed, remaining, limit, resetAt, retryAfter }
 * @param {Object} corsHeaders - CORS 头
 * @returns {Response} 429 Too Many Requests
 */
export function rateLimitResponse(result, corsHeaders = {}) {
  // X-RateLimit-Limit 是窗口内配额上限（常量），非当前剩余量。
  // result.limit 缺失时（旧调用方）退化为 remaining，保证不产生 NaN。
  const quota = Number.isFinite(result.limit) ? result.limit : result.remaining;
  const headers = {
    "Content-Type": "application/json",
    "Retry-After": String(result.retryAfter),
    "X-RateLimit-Limit": String(quota),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
    ...corsHeaders,
  };

  return new Response(
    JSON.stringify({
      error: {
        message: "Too Many Requests",
        type: "rate_limit_exceeded",
        retry_after: result.retryAfter,
      },
    }),
    { status: 429, headers }
  );
}
