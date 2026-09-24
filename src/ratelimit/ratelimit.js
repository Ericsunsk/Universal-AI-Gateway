// Token Bucket Rate Limiter
// 基于 KV 存储的分布式限流器，支持多实例共享状态

const RATE_LIMIT_PREFIX = "ratelimit:";

/**
 * 限流配置
 * @typedef {Object} RateLimitConfig
 * @property {number} capacity - 桶容量（最大令牌数）
 * @property {number} refillRate - 填充速率（令牌/秒）
 * @property {number} cost - 每次请求消耗的令牌数（默认 1）
 */

/**
 * Token Bucket 算法实现
 * 原理：固定容量的桶，以固定速率补充令牌；请求到达时尝试获取令牌，成功则放行，失败则限流。
 *
 * 公式: available = min(capacity, last_tokens + (now - last_time) * refillRate)
 *
 * @param {Object} kv - KV 存储实例
 * @param {string} key - 限流键（如 "user:123" 或 "ip:1.2.3.4"）
 * @param {RateLimitConfig} config - 限流配置
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number, retryAfter: number}>}
 */
export async function checkRateLimit(kv, key, config) {
  if (!kv) {
    // KV 不可用时默认放行（fail-open，避免限流故障影响服务）
    return { allowed: true, remaining: config.capacity, resetAt: 0, retryAfter: 0 };
  }

  const { capacity, refillRate, cost = 1 } = config;
  const now = Date.now() / 1000; // Unix timestamp (秒)
  const kvKey = `${RATE_LIMIT_PREFIX}${key}`;

  // 读取当前桶状态
  let bucket = null;
  try {
    const raw = await kv.get(kvKey, "json");
    bucket = raw && typeof raw === "object" ? raw : null;
  } catch (e) {
    // KV 读取失败，fail-open
    console.warn(`[RateLimit] KV read failed for ${key}:`, e?.message);
    return { allowed: true, remaining: capacity, resetAt: 0, retryAfter: 0 };
  }

  let tokens = capacity;
  let lastRefill = now;

  if (bucket && typeof bucket.tokens === "number" && typeof bucket.lastRefill === "number") {
    // 计算自上次以来补充的令牌数
    const elapsed = now - bucket.lastRefill;
    const refilled = elapsed * refillRate;
    tokens = Math.min(capacity, bucket.tokens + refilled);
    lastRefill = now;
  }

  // 尝试消耗令牌
  const allowed = tokens >= cost;
  const newTokens = allowed ? tokens - cost : tokens;
  const resetAt = Math.ceil(lastRefill + (capacity - newTokens) / refillRate);
  const retryAfter = allowed ? 0 : Math.ceil((cost - tokens) / refillRate);

  // 写回桶状态（异步写入，不阻塞响应）
  const newBucket = { tokens: newTokens, lastRefill: now };
  const ttl = Math.ceil(capacity / refillRate) + 60; // 桶过期时间 = 填满所需时间 + 60s 缓冲

  // 非阻塞写入：写入失败不影响当前请求判定（已在内存中完成计算）
  kv.put(kvKey, newBucket, { expirationTtl: ttl }).catch((e) => {
    console.warn(`[RateLimit] KV write failed for ${key}:`, e?.message);
  });

  return {
    allowed,
    remaining: Math.max(0, Math.floor(newTokens)),
    resetAt,
    retryAfter,
  };
}

/**
 * 预设限流配置
 */
export const RATE_LIMIT_PRESETS = {
  // 严格限流：每分钟 10 次（适用于登录、注册等敏感操作）
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
    "X-RateLimit-Limit": String(result.remaining + 1), // 实际容量（当前剩余 + 本次消耗）
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
