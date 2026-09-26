import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../src/index.js";
import { getConfig } from "../src/config/config.js";
import { createMemoryKv } from "../src/kv/index.js";

// 一个最小 env：满足 getConfig 需要的密钥 + 共享内存 KV（与生产同 Interface）。
// getBalance 会遍历 provider，但这里 provider 列表为空，不会触发真实 fetch。
function makeEnv() {
  return {
    API_KEY: "sk-test",
    MASTER_KEY: "sk-master",
    CRON_SECRET: "cs-test",
    GATEWAY_KV: createMemoryKv()
  };
}

test("/status requires auth and stays free of operational data", async () => {
  const env = makeEnv();
  // 未鉴权：401
  const anon = await handler.fetch(new Request("https://x/status"), env);
  assert.equal(anon.status, 401);

  const req = new Request("https://x/status", {
    headers: { Authorization: "Bearer sk-test" }
  });
  const resp = await handler.fetch(req, env);
  assert.equal(resp.status, 200);
  const body = await resp.json();

  // 持 key 可见无害字段
  assert.equal(body.service, "universal-ai-gateway");
  assert.ok(body.version);
  assert.equal(typeof body.kvEnabled, "boolean");

  // 敏感字段必须缺席
  assert.equal("balance" in body, false, "balance must not leak");
  assert.equal("lastCheckin" in body, false, "lastCheckin must not leak");
  assert.equal("lastRefresh" in body, false, "lastRefresh must not leak");
});

test("/healthz is minimal: status + time only", async () => {
  const env = makeEnv();
  const resp = await handler.fetch(new Request("https://x/healthz"), env);
  const body = await resp.json();
  assert.equal(body.status, "ok");
  assert.ok(body.time);
  assert.equal("balance" in body, false);
  assert.equal("version" in body, false, "version must not leak publicly");
  assert.equal("providers_active" in body, false);
  assert.equal("models_available" in body, false);
});

test("/healthz degrades to 503 when zero providers/routes configured", async () => {
  const env = makeEnv();
  await env.GATEWAY_KV.put("GATEWAY_CONFIG", JSON.stringify({ providers: [], routes: {} }));
  // getConfig 有进程级缓存，强制刷新到当前 env 的空配置，否则沿用上一个测试的默认配置
  await getConfig(env, true);
  const resp = await handler.fetch(new Request("https://x/healthz"), env);
  const body = await resp.json();
  assert.equal(resp.status, 503);
  assert.equal(body.status, "degraded");
});

test("/usage is master/admin only: client keys get 403", async () => {
  const env = makeEnv();
  await getConfig(env, true);
  const client = await handler.fetch(new Request("https://x/v1/usage", {
    headers: { Authorization: "Bearer sk-test" }
  }), env);
  assert.equal(client.status, 403);
  const master = await handler.fetch(new Request("https://x/v1/usage", {
    headers: { Authorization: "Bearer sk-master" }
  }), env);
  assert.equal(master.status, 200);
  const body = await master.json();
  assert.equal(body.code, 0);
});

test("getConfig singleflights concurrent refreshes into one KV read", async () => {
  const { getConfig } = await import("../src/config/config.js");
  let kvGets = 0;
  const store = new Map();
  const env = {
    API_KEY: "sk-test",
    MASTER_KEY: "sk-master",
    GATEWAY_KV: {
      get: async (k) => { kvGets++; await new Promise(r => { setTimeout(r, 20); }); return store.get(k) ?? null; },
      put: async (k, v) => store.set(k, v),
      delete: async (k) => { store.delete(k); }
    }
  };
  const results = await Promise.all([
    getConfig(env, true), getConfig(env, true), getConfig(env, true),
    getConfig(env, true), getConfig(env, true)
  ]);
  assert.equal(kvGets <= 2, true, "5 concurrent refreshes must trigger at most one KV read + one pre-write guard read");
  for (const r of results) assert.equal(r, results[0], "all callers share the same config");
});

test("getProviderFleet reuses instance across config refreshes with same version", async () => {
  const { getProviderFleet } = await import("../src/core/fleet.js");
  const env = {};
  const a = { config_version: 41, providers: [] };
  const b = { config_version: 41, providers: [] };
  assert.notEqual(a, b);
  const f1 = getProviderFleet(a, env);
  assert.equal(getProviderFleet(b, env), f1, "same version must reuse fleet despite new object");
  const f2 = getProviderFleet({ config_version: 42, providers: [] }, env);
  assert.notEqual(f2, f1, "bumped version must rebuild fleet");
});

test("fleet.getBalance caches upstream balance briefly", async () => {
  const { ProviderFleet } = await import("../src/core/fleet.js");
  const fleet = new ProviderFleet(
    { providers: [{ id: "cacheprobe", type: "openai", config: {} }], usage_provider_id: "cacheprobe" },
    {}
  );
  let upstreamCalls = 0;
  fleet.getProvider("cacheprobe").getBalance = async () => {
    upstreamCalls++;
    return { success: true, balance: 7, total: 70 };
  };
  const first = await fleet.getBalance();
  const second = await fleet.getBalance();
  assert.equal(upstreamCalls, 1, "second call must be served from cache");
  assert.equal(second.balance, 7);
  assert.equal(first, second);
});

test("balanceCache keeps previous providers cached and evicts only the oldest (M5)", async () => {
  const { ProviderFleet } = await import("../src/core/fleet.js");
  const fleet = new ProviderFleet({ providers: [] }, {});
  const BALANCE_CACHE_MAX_ENTRIES = 100;

  // 每个 providerId 有独立上游计数，用于观测缓存命中 vs 重算
  const upstreamCalls = new Map();
  const balanceFor = (id, balance) => async () => {
    upstreamCalls.set(id, (upstreamCalls.get(id) || 0) + 1);
    return { success: true, balance, total: balance };
  };
  fleet.getProvider = (id) => ({ id, getBalance: balanceFor(id, 42) });

  // 命中语义不变：第二次调用不再打上游
  const first = await fleet.getBalance("keepme");
  const second = await fleet.getBalance("keepme");
  assert.equal(upstreamCalls.get("keepme"), 1, "cached value still returned");
  assert.equal(first, second);

  // 灌满上界之外的真实写路径键（每个 provider 都有 getBalance → 必定落缓存），逐出最旧的 keepme
  for (let i = 0; i < BALANCE_CACHE_MAX_ENTRIES + 60; i++) {
    await fleet.getBalance(`probe-${i}`);
  }
  assert.equal(upstreamCalls.get("keepme"), 1, "keepme still cached until overwritten");

  // 重新查询 keepme：应已被逐出 → 再次命中上游（计数变 2）
  await fleet.getBalance("keepme");
  assert.equal(upstreamCalls.get("keepme"), 2, "oldest entry must have been evicted by the cap");

  // 最近的键仍缓存：probe-159 第一次刚写，第二次不再重算 → 计数停在 1
  await fleet.getBalance("probe-159");
  assert.equal(upstreamCalls.get("probe-159"), 1, "recent entry still served from cache");
});

// --- /v1/messages/count_tokens（#11）---

test("count_tokens requires auth", async () => {
  const env = makeEnv();
  const resp = await handler.fetch(new Request("https://x/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  }), env);
  assert.equal(resp.status, 401);
});

test("count_tokens returns the Anthropic shape { input_tokens }", async () => {
  const env = makeEnv();
  const resp = await handler.fetch(new Request("https://x/v1/messages/count_tokens", {
    method: "POST",
    headers: { Authorization: "Bearer sk-test", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello world" }] })
  }), env);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(typeof body.input_tokens, "number");
  assert.ok(body.input_tokens > 0, "input_tokens must be a positive number");
  assert.ok(!("content" in body), "count_tokens must not return message content");
});

test("count_tokens rejects non-POST without hitting a 500", async () => {
  const env = makeEnv();
  const resp = await handler.fetch(new Request("https://x/v1/messages/count_tokens", {
    method: "GET",
    headers: { Authorization: "Bearer sk-test" }
  }), env);
  assert.equal(resp.status, 405);
});

test("count_tokens tolerates an invalid JSON body without a 500", async () => {
  const env = makeEnv();
  const resp = await handler.fetch(new Request("https://x/v1/messages/count_tokens", {
    method: "POST",
    headers: { Authorization: "Bearer sk-test", "Content-Type": "application/json" },
    body: "{ not json"
  }), env);
  assert.equal(resp.status, 400);
  const body = await resp.json();
  assert.deepEqual(Object.keys(body), ["error"], "must use the shared error envelope");
  assert.equal(body.error.message, "Invalid JSON body");
});

test("count_tokens enforces model whitelist on virtual keys", async () => {
  const env = {
    API_KEY: "sk-test",
    MASTER_KEY: "sk-master",
    GATEWAY_KV: {
      get: async (k) => {
        if (k === "GATEWAY_CONFIG") {
          return JSON.stringify({
            virtual_keys: {
              "sk-restricted": { enabled: true, models: ["allowed-model"] }
            }
          });
        }
        return null;
      },
      put: async () => {},
      delete: async () => {}
    }
  };
  await getConfig(env, true);
  try {
    const respForbidden = await handler.fetch(new Request("https://x/v1/messages/count_tokens", {
      method: "POST",
      headers: { Authorization: "Bearer sk-restricted", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "forbidden-model", messages: [{ role: "user", content: "hi" }] })
    }), env);
    assert.equal(respForbidden.status, 403);

    const respAllowed = await handler.fetch(new Request("https://x/v1/messages/count_tokens", {
      method: "POST",
      headers: { Authorization: "Bearer sk-restricted", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "allowed-model", messages: [{ role: "user", content: "hi" }] })
    }), env);
    assert.equal(respAllowed.status, 200);
  } finally {
    await getConfig(makeEnv(), true);
  }
});
