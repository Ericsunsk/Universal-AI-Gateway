import { test } from "node:test";
import assert from "node:assert/strict";
import handler from "../src/index.js";

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
