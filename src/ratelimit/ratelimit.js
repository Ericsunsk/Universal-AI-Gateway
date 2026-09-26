// Rate Limiter
// 基于 KV 持久化层 seam 的统一限流入口与协议工具

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
  if (principal?.name) {
    const hash = hashString32(principal.name);
    return `key:${hash}`;
  }

  // 2. 未认证或匿名：使用 IP 地址
  const ip =
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    "unknown";

  return `ip:${ip}`;
}

// 简单的字符串哈希函数（32-bit FNV-1a）
function hashString32(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
