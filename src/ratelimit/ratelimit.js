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
  if (!kv || typeof kv.limit !== "function") {
    // KV 不可用或无限流能力时 fail-open
    return { allowed: true, remaining: config?.capacity ?? 0, resetAt: 0, retryAfter: 0 };
  }
  return kv.limit(key, config);
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
 * @param {Object} result - checkRateLimit 返回结果
 * @param {Object} corsHeaders - CORS 头
 * @returns {Response} 429 Too Many Requests
 */
export function rateLimitResponse(result, corsHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Retry-After": String(result.retryAfter),
    "X-RateLimit-Limit": String(result.remaining + 1),
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
