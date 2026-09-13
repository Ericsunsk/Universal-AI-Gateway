import { test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultConfig, redactConfig, saveConfig, validateConfig } from "../src/config/config.js";
import { timingSafeEqual, authenticateAccess } from "../src/auth/auth.js";
import { buildResponseHeaders } from "../src/http/headers.js";

// ---- #1 密钥兜底必须抛错 ----
test("missing secrets throw instead of hardcoded default", () => {
  assert.throws(() => getDefaultConfig({}), /API_KEY/);
  // API_KEY 提供后 MASTER_KEY 回退到 API_KEY，不抛错
  assert.doesNotThrow(() => getDefaultConfig({ API_KEY: "k" }));
});

test("explicit MASTER_KEY honored, falls back to API_KEY otherwise", () => {
  assert.equal(getDefaultConfig({ API_KEY: "ak" }).master_key, "ak");
  assert.equal(getDefaultConfig({ API_KEY: "ak", MASTER_KEY: "mk" }).master_key, "mk");
});

// ---- #3 常数时间比较 ----
test("timingSafeEqual", () => {
  assert.equal(timingSafeEqual("abc123", "abc123"), true);
  assert.equal(timingSafeEqual("abc123", "abc124"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual(null, "abc"), false);
  assert.equal(timingSafeEqual("abc", 123), false);
});

// ---- #4 鉴权门禁 ----
const cfg = getDefaultConfig({ API_KEY: "sk-real", MASTER_KEY: "sk-master", CRON_SECRET: "cs" });
const req = (t) => new Request("https://x/y", { headers: t ? { Authorization: "Bearer " + t } : {} });

test("master key accepted, cron secret rejected by default", () => {
  assert.equal(authenticateAccess(req("sk-master"), cfg).ok, true);
  assert.equal(authenticateAccess(req("cs"), cfg).ok, false);
  assert.equal(authenticateAccess(req("sk-wrong"), cfg).ok, false);
  assert.equal(authenticateAccess(req(null), cfg).ok, false);
});

test("cron secret accepted only on cron-gated endpoints (allowCron=true)", () => {
  assert.equal(authenticateAccess(req("cs"), cfg, { allowCron: true }).ok, true);
  const cronAuth = authenticateAccess(req("cs"), cfg, { allowCron: true });
  assert.equal(cronAuth.principal.isMaster, false, "cron principal must NOT be master");
  assert.equal(cronAuth.principal.role, "cron");
});

test("cron secret rejected on admin endpoints (requireMaster=true)", () => {
  assert.equal(authenticateAccess(req("cs"), cfg, { requireMaster: true }).ok, false);
});

test("cron accepted on checkin-style gate (requireMaster+allowCron)", () => {
  // /checkin 用 {requireMaster:true, allowCron:true}：master 与 cron 都放行，cron 仍降权
  assert.equal(authenticateAccess(req("sk-master"), cfg, { requireMaster: true, allowCron: true }).ok, true);
  const cronAuth = authenticateAccess(req("cs"), cfg, { requireMaster: true, allowCron: true });
  assert.equal(cronAuth.ok, true, "cron must reach /checkin");
  assert.equal(cronAuth.principal.isMaster, false);
  assert.equal(cronAuth.principal.role, "cron");
  assert.equal(authenticateAccess(req("sk-wrong"), cfg, { requireMaster: true, allowCron: true }).ok, false);
});

test("plain API_KEY is not master", () => {
  const r = authenticateAccess(req("sk-real"), cfg);
  assert.equal(r.ok, true);
  assert.equal(r.principal.isMaster, false);
});

// ---- #2 脱敏 ----
test("redactConfig hides all secret material", () => {
  const full = getDefaultConfig({
    API_KEY: "APIKEY-LEAK", MASTER_KEY: "MASTER-LEAK", CRON_SECRET: "CRON-LEAK",
    ACCESS_TOKEN: "ACCESS-LEAK", REFRESH_TOKEN: "REFRESH-LEAK", USER_ID: "u1"
  });
  const dump = JSON.stringify(redactConfig(full));
  for (const v of ["APIKEY-LEAK", "MASTER-LEAK", "CRON-LEAK", "ACCESS-LEAK", "REFRESH-LEAK"]) {
    assert.equal(dump.includes(v), false, `leaked ${v}`);
  }
  assert.equal(dump.includes("u1"), true, "non-secret userId should survive");
});

// ---- #2 合并式写入 ----
function fakeKv(store) {
  return { get: async (k) => store.get(k) ?? null, put: async (k, v) => store.set(k, v) };
}
test("merge-on-write preserves secrets across redacted round-trip", async () => {
  const store = new Map();
  const env = { GATEWAY_KV: fakeKv(store) };
  const secret = "SECRET-A";
  await saveConfig(env, {
    providers: [{ id: "wb", config: { accounts: [{ id: "a", accessToken: secret }] } }],
    routes: { m: [{ provider: "wb", model: "x" }] }
  });
  const stored = JSON.parse(store.get("GATEWAY_CONFIG"));
  assert.equal(stored.providers[0].config.accounts[0].accessToken, secret);

  // 客户端回传脱敏视图
  await saveConfig(env, redactConfig(stored));
  const after = JSON.parse(store.get("GATEWAY_CONFIG"));
  assert.equal(after.providers[0].config.accounts[0].accessToken, secret, "secret must survive round-trip");
});

test("explicit new secret overwrites", async () => {
  const store = new Map();
  const env = { GATEWAY_KV: fakeKv(store) };
  await saveConfig(env, { providers: [{ id: "wb", config: { accounts: [{ id: "a", accessToken: "OLD" }] } }], routes: { m: [{ provider: "wb" }] } });
  const patch = redactConfig(JSON.parse(store.get("GATEWAY_CONFIG")));
  patch.providers[0].config.accounts[0].accessToken = "NEW";
  await saveConfig(env, patch);
  assert.equal(JSON.parse(store.get("GATEWAY_CONFIG")).providers[0].config.accounts[0].accessToken, "NEW");
});

test("config version conflict returns 409", async () => {
  const store = new Map();
  const env = { GATEWAY_KV: fakeKv(store) };
  await saveConfig(env, { providers: [{ id: "wb", config: { accounts: [{ id: "a", accessToken: "OLD" }] } }], routes: { m: [{ provider: "wb" }] } });
  const stored = JSON.parse(store.get("GATEWAY_CONFIG"));
  // A client reads config_version=1 and tries to save with that version
  const clientA = redactConfig(JSON.parse(JSON.stringify(stored)));
  // B also reads and modifies concurrently
  const clientB = redactConfig(JSON.parse(JSON.stringify(stored)));
  clientB.providers[0].config.accounts[0].accessToken = "B-CHANGE";
  await saveConfig(env, clientB);
  // Now A tries to save with stale version=1 → should throw 409
  await assert.rejects(saveConfig(env, clientA), /version conflict/, "stale version should throw 409");
});

// ---- #10 schema 校验 ----
test("validateConfig rejects malformed routes", () => {
  // routes 引用了不存在的 provider → 被拒绝
  assert.ok(validateConfig({ providers: [], routes: { m: [{ provider: "wb" }] } }).length > 0, "unknown provider in routes");
  assert.ok(validateConfig({ providers: [], routes: { m: [{ model: "x" }] } }).length > 0, "missing provider");
  assert.ok(validateConfig({ providers: [] }).length > 0, "missing routes");
  assert.ok(validateConfig({ providers: [], routes: { m: [] } }).length > 0, "empty route array");
});

test("validateConfig rejects duplicate ids and zero-account providers", () => {
  const dupProviders = {
    providers: [{ id: "wb" }, { id: "wb" }],
    routes: { m: [{ provider: "wb" }] }
  };
  assert.ok(validateConfig(dupProviders).some(e => e.includes('duplicate provider id')), "duplicate provider id");
  const dupAccounts = {
    providers: [{ id: "wb", config: { accounts: [{ id: "a" }, { id: "a" }] } }],
    routes: { m: [{ provider: "wb" }] }
  };
  assert.ok(validateConfig(dupAccounts).some(e => e.includes('duplicate account id')), "duplicate account id");
  const zeroAccounts = {
    providers: [{ id: "wb", config: { accounts: [] } }],
    routes: { m: [{ provider: "wb" }] }
  };
  assert.ok(validateConfig(zeroAccounts).some(e => e.includes('zero accounts')), "zero accounts");
  const missingAccountId = {
    providers: [{ id: "wb", config: { accounts: [{}] } }],
    routes: { m: [{ provider: "wb" }] }
  };
  assert.ok(validateConfig(missingAccountId).some(e => e.includes('missing id')), "account missing id");
});

// ---- #9 响应头过滤 ----
test("buildResponseHeaders strips hop-by-hop headers", () => {
  const upstream = new Headers({
    "Content-Type": "application/json",
    "Content-Length": "999",
    "Transfer-Encoding": "chunked",
    "Set-Cookie": "session=abc",
    "Connection": "keep-alive",
    "X-RateLimit-Remaining": "42"
  });
  const h = buildResponseHeaders(upstream, { "X-Gateway-Account": "primary" });
  const result = Object.fromEntries(h.entries());
  assert.equal("content-length" in result, false);
  assert.equal("transfer-encoding" in result, false);
  assert.equal("set-cookie" in result, false);
  assert.equal("connection" in result, false);
  assert.equal(result["x-ratelimit-remaining"], "42");
  assert.equal(result["x-gateway-account"], "primary");
});
