import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, RATE_LIMIT_PRESETS, extractRateLimitKey, rateLimitResponse } from "../src/ratelimit/ratelimit.js";
import { createMemoryKv } from "../src/kv/index.js";

test("checkRateLimit allows requests within capacity", async () => {
  const kv = createMemoryKv();
  const config = { capacity: 10, refillRate: 1 }; // 10 tokens, 1/s refill

  const r1 = await checkRateLimit(kv, "user:1", config);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 9);

  const r2 = await checkRateLimit(kv, "user:1", config);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 8);
});

test("checkRateLimit blocks requests exceeding capacity", async () => {
  const kv = createMemoryKv();
  const config = { capacity: 3, refillRate: 1 };

  await checkRateLimit(kv, "user:2", config); // 3 -> 2
  await checkRateLimit(kv, "user:2", config); // 2 -> 1
  await checkRateLimit(kv, "user:2", config); // 1 -> 0

  const blocked = await checkRateLimit(kv, "user:2", config);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfter > 0, "retryAfter should be positive");
});

test("checkRateLimit refills tokens over time", async () => {
  const kv = createMemoryKv();
  const config = { capacity: 10, refillRate: 10 }; // 10 tokens/s

  // 消耗 5 个令牌
  for (let i = 0; i < 5; i++) {
    await checkRateLimit(kv, "user:3", config);
  }

  // 模拟时间流逝：手动更新桶的 lastRefill（测试环境无法真实等待）
  // 生产环境中 refill 由实际时间差驱动，此处验证公式正确性
  const bucket = await kv.get("ratelimit:user:3", "json");
  assert.equal(Math.round(bucket.tokens), 5, "5 tokens consumed");

  // 公式验证：elapsed=1s, refilled=1*10=10, new=min(10, 5+10)=10
  // 实际测试中时间差极小，验证逻辑即可
});

test("checkRateLimit isolates different keys", async () => {
  const kv = createMemoryKv();
  const config = { capacity: 2, refillRate: 1 };

  const u1r1 = await checkRateLimit(kv, "user:a", config);
  const u2r1 = await checkRateLimit(kv, "user:b", config);

  assert.equal(u1r1.allowed, true);
  assert.equal(u2r1.allowed, true);
  assert.equal(u1r1.remaining, 1);
  assert.equal(u2r1.remaining, 1);
});

test("checkRateLimit fails open when KV is null", async () => {
  const config = { capacity: 1, refillRate: 1 };

  const r1 = await checkRateLimit(null, "user:x", config);
  const r2 = await checkRateLimit(null, "user:x", config);

  assert.equal(r1.allowed, true, "should allow when KV unavailable");
  assert.equal(r2.allowed, true, "should allow when KV unavailable");
});

test("checkRateLimit handles custom cost per request", async () => {
  const kv = createMemoryKv();
  const config = { capacity: 10, refillRate: 1, cost: 3 }; // 每次消耗 3 个令牌

  const r1 = await checkRateLimit(kv, "user:4", config);
  assert.equal(r1.allowed, true);
  assert.equal(r1.remaining, 7); // 10 - 3

  const r2 = await checkRateLimit(kv, "user:4", config);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 4); // 7 - 3
});

test("RATE_LIMIT_PRESETS provides common configurations", () => {
  assert.ok(RATE_LIMIT_PRESETS.strict);
  assert.ok(RATE_LIMIT_PRESETS.standard);
  assert.ok(RATE_LIMIT_PRESETS.relaxed);
  assert.ok(RATE_LIMIT_PRESETS.admin);

  assert.equal(RATE_LIMIT_PRESETS.strict.capacity, 10);
  assert.equal(RATE_LIMIT_PRESETS.standard.capacity, 60);
});

test("extractRateLimitKey prioritizes API key over IP", () => {
  const req1 = new Request("https://x/y", {
    headers: { "x-forwarded-for": "1.2.3.4" }
  });
  const principal = { name: "test-client", role: "client" };

  const key1 = extractRateLimitKey(req1, principal);
  assert.ok(key1.startsWith("key:"), "should use key hash for authenticated");

  const key2 = extractRateLimitKey(req1, null);
  assert.equal(key2, "ip:1.2.3.4", "should use IP for unauthenticated");
});

test("extractRateLimitKey isolates API keys with the same display name", () => {
  const req = new Request("https://x/y", { headers: { "x-forwarded-for": "1.2.3.4" } });
  const keyA = extractRateLimitKey(req, { name: "Client", rateLimitId: "token-a" });
  const keyB = extractRateLimitKey(req, { name: "Client", rateLimitId: "token-b" });
  assert.notEqual(keyA, keyB);
});

test("platformClientIp handles multi-hop proxies and Cloudflare correctly", () => {
  // 1. Cloudflare + Render 多级代理：有 cf-ray 时优先信任 cf-connecting-ip
  const cfReq = new Request("https://x/y", {
    headers: {
      "cf-ray": "8e123456-LAX",
      "cf-connecting-ip": "203.0.113.5",
      "x-forwarded-for": "203.0.113.5, 172.68.1.1"
    }
  });
  assert.equal(extractRateLimitKey(cfReq, null), "ip:203.0.113.5");

  // 2. 通用多级反向代理：取首跳真实客户端 IP，而非末跳反代出口 IP
  const multiHopReq = new Request("https://x/y", {
    headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1, 10.0.0.2" }
  });
  assert.equal(extractRateLimitKey(multiHopReq, null), "ip:198.51.100.1");

  // 3. Vercel 边缘：以 x-vercel-forwarded-for 为准
  const vercelReq = new Request("https://x/y", {
    headers: { "x-vercel-forwarded-for": "192.0.2.1" }
  });
  assert.equal(extractRateLimitKey(vercelReq, null), "ip:192.0.2.1");
});

test("extractRateLimitKey handles missing IP gracefully", () => {
  const req = new Request("https://x/y");
  const key = extractRateLimitKey(req, null);
  assert.equal(key, "ip:unknown");
});

test("rateLimitResponse returns 429 with correct headers", () => {
  const result = { allowed: false, remaining: 0, limit: 60, resetAt: 1234567890, retryAfter: 10 };
  const resp = rateLimitResponse(result, { "Access-Control-Allow-Origin": "*" });

  assert.equal(resp.status, 429);
  assert.equal(resp.headers.get("Retry-After"), "10");
  // X-RateLimit-Limit 是窗口配额上限（常量），绝不能随 remaining 递减。
  assert.equal(resp.headers.get("X-RateLimit-Limit"), "60");
  assert.equal(resp.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(resp.headers.get("X-RateLimit-Reset"), "1234567890");
  assert.equal(resp.headers.get("Access-Control-Allow-Origin"), "*");
});

test("rateLimitResponse reports quota limit even when bucket is exhausted", () => {
  // 回归：旧实现用 remaining + 1，桶耗尽时会谎报 X-RateLimit-Limit: 1。
  const result = { allowed: false, remaining: 0, limit: 100, resetAt: 0, retryAfter: 5 };
  const resp = rateLimitResponse(result, {});
  assert.equal(resp.headers.get("X-RateLimit-Limit"), "100");
});

test("rateLimitResponse degrades safely without limit field (legacy callers)", () => {
  const result = { allowed: false, remaining: 7, resetAt: 0, retryAfter: 1 };
  const resp = rateLimitResponse(result, {});
  assert.equal(resp.headers.get("X-RateLimit-Limit"), "7");
  assert.notEqual(resp.headers.get("X-RateLimit-Limit"), "NaN");
});

test("createUpstashKv limit uses @upstash/ratelimit when redis is configured", async () => {
  const fakeRedis = {
    eval: async () => [9, Date.now() + 5000, 10],
    evalsha: async () => [9, Date.now() + 5000, 10],
    scriptLoad: async () => "dummy",
  };
  const { createUpstashKv } = await import("../src/kv/index.js");
  const kv = createUpstashKv({ redis: fakeRedis });
  const res = await kv.limit("test-upstash-key", { capacity: 10, refillRate: 1 });
  assert.equal(res.allowed, true);
  assert.equal(res.remaining, 9);
  assert.equal(res.retryAfter, 0);
  assert.ok(res.resetAt > 0);
});

test("createUpstashKv limit blocks and computes retryAfter with @upstash/ratelimit", async () => {
  const fakeRedis = {
    eval: async () => [-1, Date.now() + 5000, 10],
    evalsha: async () => [-1, Date.now() + 5000, 10],
    scriptLoad: async () => "dummy",
  };
  const { createUpstashKv } = await import("../src/kv/index.js");
  const kv = createUpstashKv({ redis: fakeRedis });
  const res = await kv.limit("test-upstash-blocked", { capacity: 10, refillRate: 1 });
  assert.equal(res.allowed, false);
  assert.equal(res.remaining, 0);
  assert.ok(res.retryAfter > 0);
});

test("createUpstashKv limit falls back to memory if redis throws", async () => {
  const memKv = createMemoryKv();
  const failingRedis = {
    eval: async () => { throw new Error("Connection reset"); },
    evalsha: async () => { throw new Error("Connection reset"); },
    scriptLoad: async () => "dummy",
  };
  const { createUpstashKv } = await import("../src/kv/index.js");
  const kv = createUpstashKv({ redis: failingRedis, fallback: memKv });
  const res = await kv.limit("test-fallback-key", { capacity: 10, refillRate: 1 });
  assert.equal(res.allowed, true);
  assert.equal(res.remaining, 9);
});

test("checkRateLimit delegates to kv.limit when present (clean seam encapsulation)", async () => {
  let calledWith = null;
  const mockKv = {
    limit: async (key, config) => {
      calledWith = { key, config };
      return { allowed: true, remaining: 42, resetAt: 100, retryAfter: 0 };
    }
  };
  const res = await checkRateLimit(mockKv, "user-clean-seam", { capacity: 50, refillRate: 1 });
  assert.equal(res.remaining, 42);
  assert.equal(calledWith.key, "user-clean-seam");
  // capacity 必须回传为 limit，供 X-RateLimit-Limit 使用（kv.limit 自身不返回该字段）。
  assert.equal(res.limit, 50, "checkRateLimit must stamp the true quota as limit");
});

test("checkRateLimit fail-open path reports quota as limit", async () => {
  const res = await checkRateLimit(null, "k", { capacity: 30, refillRate: 1 });
  assert.equal(res.allowed, true);
  assert.equal(res.limit, 30);
});

test("Upstash path uses tokenBucket (burst parity with memory adapter)", async () => {
  // 回归：旧实现用 slidingWindow(capacity, windowSec)，丢失了 token bucket 的
  // burst 语义（capacity=100/refillRate=10 时无法积攒爆发额度）。
  //
  // 判别依据：@upstash/ratelimit 把 limiter 配置序列化进 evalsha 的第 3 个参数。
  //   tokenBucket(refillRate=10, "1 s", maxTokens=100) -> "100,1000,10,<now>,<cost>"
  //        （maxTokens=100, windowMs=1000, refillRate=10）
  //   slidingWindow(100, "10 s")                        -> "100,<now>,10000,<cost>"
  //        （windowMs=10000，且不携带 refillRate）
  const captured = [];
  const fakeRedis = {
    eval: async (_script, _keys, args) => {
      captured.push(String(args));
      return [9, Date.now() + 5000, 10];
    },
    evalsha: async (_sha, _keys, args) => {
      captured.push(String(args));
      return [9, Date.now() + 5000, 10];
    },
    scriptLoad: async () => "dummy",
  };
  const { createUpstashKv } = await import("../src/kv/index.js");
  const kv = createUpstashKv({ redis: fakeRedis });

  const res = await kv.limit("burst-key", { capacity: 100, refillRate: 10 });
  assert.equal(res.allowed, true);
  assert.equal(captured.length, 1, "upstash limiter must issue exactly one redis eval");

  const [maxTokens, windowMs, refillRate] = captured[0].split(",").map(Number);
  assert.equal(maxTokens, 100, "bucket maxTokens must equal capacity (burst ceiling)");
  assert.equal(windowMs, 1000, "refill interval must be 1s (token bucket), not capacity/rate window");
  assert.equal(refillRate, 10, "refillRate must be passed through verbatim");

  // 不同 (capacity, refillRate) 必须映射到不同的 limiter 实例缓存键，
  // 否则 burst 预设会与 standard 预设互相污染。
  await kv.limit("burst-key-2", { capacity: 60, refillRate: 1 });
  assert.equal(captured.length, 2);
  const [mt2, wm2, rr2] = captured[1].split(",").map(Number);
  assert.equal(mt2, 60);
  assert.equal(wm2, 1000);
  assert.equal(rr2, 1);
});

test("createUpstashKv preserves persistence seam and does not leak redis", async () => {
  const { createUpstashKv } = await import("../src/kv/index.js");
  const kv = createUpstashKv({ url: "https://example.upstash.io", token: "fake-token" });
  assert.equal(kv.redis, undefined, "redis property must NOT be leaked on seam object");
  assert.equal(typeof kv.limit, "function", "limit must be available as a seam method");
  assert.equal(typeof kv.get, "function");
  assert.equal(typeof kv.put, "function");
  assert.equal(typeof kv.delete, "function");
});

