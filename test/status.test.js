import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../src/index.js";
import { getConfig } from "../src/config/config.js";

// 一个最小 env：满足 getConfig 需要的密钥 + 一个内存 KV mock。
// getBalance 会遍历 provider，但这里 provider 列表为空，不会触发真实 fetch。
function makeEnv() {
  const store = new Map();
  return {
    API_KEY: "sk-test",
    MASTER_KEY: "sk-master",
    CRON_SECRET: "cs-test",
    GATEWAY_KV: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => store.set(k, v),
      delete: async (k) => { store.delete(k); },
      list: async () => ({ keys: [] })
    }
  };
}

test("/status does not leak balance or operational data", async () => {
  const env = makeEnv();
  const req = new Request("https://x/status");
  const resp = await handler.fetch(req, env, {});
  assert.equal(resp.status, 200);
  const body = await resp.json();

  // 只允许无害字段
  assert.equal(body.service, "universal-ai-gateway");
  assert.ok(body.version);
  assert.equal(typeof body.kvEnabled, "boolean");

  // 敏感字段必须缺席
  assert.equal("balance" in body, false, "balance must not leak");
  assert.equal("lastCheckin" in body, false, "lastCheckin must not leak");
  assert.equal("lastRefresh" in body, false, "lastRefresh must not leak");
});

test("/healthz also stays harmless", async () => {
  const env = makeEnv();
  const resp = await handler.fetch(new Request("https://x/healthz"), env, {});
  const body = await resp.json();
  assert.equal(body.status, "ok");
  assert.equal("balance" in body, false);
});

test("/healthz degrades to 503 when zero providers/routes configured", async () => {
  const env = makeEnv();
  await env.GATEWAY_KV.put("GATEWAY_CONFIG", JSON.stringify({ providers: [], routes: {} }));
  // getConfig 有进程级缓存，强制刷新到当前 env 的空配置，否则沿用上一个测试的默认配置
  await getConfig(env, true);
  const resp = await handler.fetch(new Request("https://x/healthz"), env, {});
  const body = await resp.json();
  assert.equal(resp.status, 503);
  assert.equal(body.status, "degraded");
});

test("getConfig singleflights concurrent refreshes into one KV read", async () => {
  const { getConfig } = await import("../src/config/config.js");
  let kvGets = 0;
  const store = new Map();
  const env = {
    API_KEY: "sk-test",
    MASTER_KEY: "sk-master",
    GATEWAY_KV: {
      get: async (k) => { kvGets++; await new Promise(r => setTimeout(r, 20)); return store.get(k) ?? null; },
      put: async (k, v) => store.set(k, v),
      delete: async (k) => { store.delete(k); }
    }
  };
  const results = await Promise.all([
    getConfig(env, true), getConfig(env, true), getConfig(env, true),
    getConfig(env, true), getConfig(env, true)
  ]);
  assert.equal(kvGets, 1, "5 concurrent refreshes must trigger a single KV read");
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
