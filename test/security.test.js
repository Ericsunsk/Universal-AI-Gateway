import { test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultConfig, backfillMissingRoutes, parseMaxContextTurns } from "../src/config/config.js";
import { timingSafeEqual, authenticateAccess } from "../src/auth/auth.js";
import { buildResponseHeaders } from "../src/http/headers.js";

// ---- #1 密钥兜底必须抛错 ----
test("missing secrets throw instead of hardcoded default", () => {
  assert.throws(() => getDefaultConfig({}), /API_KEY/);
  // API_KEY 提供后 MASTER_KEY 回退到 API_KEY，不抛错
  assert.doesNotThrow(() => getDefaultConfig({ API_KEY: "k" }));
});

test("explicit MASTER_KEY honored, missing MASTER_KEY fails closed (no API_KEY fallback)", () => {
  const fallback = getDefaultConfig({ API_KEY: "ak" }).master_key;
  assert.notEqual(fallback, "ak", "must not fall back to API_KEY");
  assert.ok(String(fallback).startsWith("unset-master-"));
  assert.equal(getDefaultConfig({ API_KEY: "ak", MASTER_KEY: "mk" }).master_key, "mk");
});

// ---- H5：MAX_CONTEXT_TURNS 非法值不得变 NaN（NaN 会静默裁掉整段历史） ----
test("parseMaxContextTurns coerces invalid values to 0 (no pruning)", () => {
  assert.equal(parseMaxContextTurns(undefined), 0);
  assert.equal(parseMaxContextTurns(null), 0);
  assert.equal(parseMaxContextTurns(""), 0);
  assert.equal(parseMaxContextTurns("   "), 0);
  assert.equal(parseMaxContextTurns("abc"), 0, "non-numeric must not become NaN");
  assert.equal(parseMaxContextTurns("40abc"), 0, "trailing junk rejected (Number semantics, not parseInt)");
  assert.equal(parseMaxContextTurns("3.7"), 3, "float string floors");
  assert.equal(parseMaxContextTurns(3.9), 3);
  assert.equal(parseMaxContextTurns(true), 0, "boolean must not enable pruning via Number(true)===1");
  assert.equal(parseMaxContextTurns(false), 0);
  assert.equal(parseMaxContextTurns("-5"), 0, "negative disables pruning");
  assert.equal(parseMaxContextTurns("0"), 0);
  assert.equal(parseMaxContextTurns(" 40 "), 40, "surrounding whitespace tolerated");
  assert.equal(parseMaxContextTurns("40"), 40);
  assert.equal(parseMaxContextTurns(40), 40);
});

test("default config never carries a NaN max_context_turns", () => {
  const cfg = getDefaultConfig({ API_KEY: "k", MAX_CONTEXT_TURNS: "not-a-number" });
  assert.equal(Number.isNaN(cfg.max_context_turns), false);
  assert.equal(cfg.max_context_turns, 0);
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

test("cron secret rejected on master-gated endpoints (requireMaster=true)", () => {
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

// ---- #9 响应头过滤（allowlist：只透传 content-type + 网关自有头） ----
test("buildResponseHeaders allowlists content-type only", () => {
  const upstream = new Headers({
    "Content-Type": "application/json",
    "Content-Length": "999",
    "Transfer-Encoding": "chunked",
    "Set-Cookie": "session=abc",
    "Connection": "keep-alive",
    "X-RateLimit-Remaining": "42",
    "Location": "https://evil.example/"
  });
  const h = buildResponseHeaders(upstream, { "X-Gateway-Account": "primary" });
  const result = Object.fromEntries(h.entries());
  assert.equal("content-length" in result, false);
  assert.equal("transfer-encoding" in result, false);
  assert.equal("set-cookie" in result, false);
  assert.equal("connection" in result, false);
  assert.equal("x-ratelimit-remaining" in result, false, "non-allowlisted upstream headers are dropped");
  assert.equal("location" in result, false, "upstream must not inject Location");
  assert.equal(result["content-type"], "application/json");
  assert.equal(result["x-gateway-account"], "primary");
});

// ---- #10 存量 KV 路由回填（只增不改） ----
test("backfillMissingRoutes adds missing default routes without touching existing", () => {
  const defaults = {
    providers: [{ id: "workbuddy", enabled: true }],
    routes: {
      "m-default": [{ provider: "workbuddy", model: "m-default" }],
      "m-shared": [{ provider: "workbuddy", model: "m-shared" }]
    }
  };
  const stored = {
    providers: [{ id: "workbuddy", enabled: true }],
    routes: { "m-shared": [{ provider: "workbuddy", model: "m-shared" }] }
  };
  const custom = [{ provider: "workbuddy", model: "custom-model" }];
  stored.routes["my-custom"] = custom;
  const out = backfillMissingRoutes(stored, defaults);
  assert.ok(out.routes["m-default"], "missing default route backfilled");
  assert.deepEqual(out.routes["my-custom"], custom, "custom route untouched");
  assert.deepEqual(out.routes["m-shared"], defaults.routes["m-shared"]);
});

test("backfillMissingRoutes keeps empty-provider config empty (degraded path)", () => {
  const defaults = { providers: [{ id: "p" }], routes: { m: [{ provider: "p" }] } };
  const stored = { providers: [], routes: {} };
  backfillMissingRoutes(stored, defaults);
  assert.deepEqual(stored.routes, {}, "no providers -> no backfill, stays degraded");
});

test("backfillMissingRoutes skips routes referencing unknown providers", () => {
  const defaults = {
    providers: [{ id: "workbuddy" }, { id: "workbuddy-intl" }],
    routes: {
      "route-wb": [{ provider: "workbuddy", model: "x" }],
      "route-intl": [{ provider: "workbuddy-intl", model: "y" }]
    }
  };
  const stored = {
    providers: [{ id: "workbuddy", config: {} }],
    routes: {}
  };
  backfillMissingRoutes(stored, defaults);
  assert.ok(stored.routes["route-wb"], "workbuddy-only route backfilled");
  assert.equal(stored.routes["route-intl"], undefined, "workbuddy-intl route skipped (unknown provider)");
});

test("defaults include disabled workbuddy-intl slot with zero runtime effect", () => {
  const defaults = getDefaultConfig({ API_KEY: "k" });
  const intl = defaults.providers.find((p) => p.id === "workbuddy-intl");
  assert.ok(intl, "intl slot present");
  assert.equal(intl.enabled, false);
  assert.equal(intl.config.region, "intl");
});

test("defaults enable workbuddy-intl only when INTL_* secrets present", () => {
  const withIntl = getDefaultConfig({ API_KEY: "k", INTL_USER_ID: "u", INTL_ACCESS_TOKEN: "a", INTL_REFRESH_TOKEN: "r" });
  const intl = withIntl.providers.find((p) => p.id === "workbuddy-intl");
  assert.equal(intl.enabled, true);
  assert.equal(intl.config.region, "intl");
  assert.equal(intl.config.accounts[0].userId, "u");
  const without = getDefaultConfig({ API_KEY: "k" });
  assert.equal(without.providers.find((p) => p.id === "workbuddy-intl").enabled, false);
});

