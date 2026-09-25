import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderFleet,
  getProviderFleet,
  toFleetConfig,
  fleetConfigEquals,
} from "../src/core/fleet.js";

// C4：fleet 重建规则显式化为 FleetConfig 值对象。
// 锁定修复的核心回归面：凭据漂移（baseUrl/apiKey/balanceUrl/账号 token）
// 在不 bump config_version 时同样重建 fleet，不再持有 stale provider。
// 版本号在本文件内唯一，避免与 status.test.js / audit-fixes.test.js 的
// 模块单例缓存相互干扰（同文件内各用例亦互不复用版本号）。

function openaiProvider(id, config) {
  return { id, type: "openai", enabled: true, config };
}

test("C4: baseUrl drift rebuilds fleet without version bump", () => {
  const env = {};
  const v = 71001;
  const a = { config_version: v, providers: [openaiProvider("c4o1", { baseUrl: "https://a.example.com", apiKey: "sk-a" })] };
  const f1 = getProviderFleet(a, env);
  assert.equal(f1.getProvider("c4o1").baseUrl, "https://a.example.com");
  const b = { config_version: v, providers: [openaiProvider("c4o1", { baseUrl: "https://b.example.com", apiKey: "sk-a" })] };
  const f2 = getProviderFleet(b, env);
  assert.notEqual(f2, f1, "baseUrl change must rebuild fleet");
  assert.equal(f2.getProvider("c4o1").baseUrl, "https://b.example.com");
});

test("C4: apiKey drift rebuilds fleet and serves the new key", () => {
  const env = {};
  const v = 71002;
  const a = { config_version: v, providers: [openaiProvider("c4o2", { baseUrl: "https://a.example.com", apiKey: "sk-a" })] };
  const f1 = getProviderFleet(a, env);
  const b = { config_version: v, providers: [openaiProvider("c4o2", { baseUrl: "https://a.example.com", apiKey: "sk-b" })] };
  const f2 = getProviderFleet(b, env);
  assert.notEqual(f2, f1, "apiKey change must rebuild fleet");
  assert.equal(f2.getProvider("c4o2").apiKey, "sk-b");
});

test("C4: balanceUrl drift rebuilds fleet without version bump", () => {
  const env = {};
  const v = 71003;
  const a = { config_version: v, providers: [openaiProvider("c4o3", { apiKey: "sk-a" })] };
  const f1 = getProviderFleet(a, env);
  const b = { config_version: v, providers: [openaiProvider("c4o3", { apiKey: "sk-a", balanceUrl: "https://bal.example.com/v1" })] };
  assert.notEqual(getProviderFleet(b, env), f1, "balanceUrl change must rebuild fleet");
});

test("C4: workbuddy account credential drift rebuilds fleet", () => {
  const env = {};
  const v = 71004;
  const mk = (token) => ({
    config_version: v,
    providers: [{
      id: "c4wb", type: "workbuddy", enabled: true,
      config: { accounts: [{ id: "a1", enabled: true, userId: "u1", accessToken: token, refreshToken: "r1" }] },
    }],
  });
  const f1 = getProviderFleet(mk("t1"), env);
  const f2 = getProviderFleet(mk("t2"), env);
  assert.notEqual(f2, f1, "account accessToken change must rebuild fleet");
  assert.equal(f2.getProvider("c4wb").config.accounts[0].accessToken, "t2");
});

test("C4: usage_provider_id drift rebuilds fleet (getBalance default target)", () => {
  const env = {};
  const v = 71005;
  const providers = [openaiProvider("c4o5", { apiKey: "sk-a" })];
  const f1 = getProviderFleet({ config_version: v, usage_provider_id: "c4o5", providers }, env);
  const f2 = getProviderFleet({ config_version: v, usage_provider_id: "other", providers }, env);
  assert.notEqual(f2, f1, "usage_provider_id change must rebuild fleet");
});

test("C4: identical content reuses fleet despite new object and shuffled key order", () => {
  const env = {};
  const v = 71006;
  const a = {
    config_version: v,
    usage_provider_id: "c4o6",
    providers: [openaiProvider("c4o6", { baseUrl: "https://a.example.com", apiKey: "sk-a" })],
  };
  const f1 = getProviderFleet(a, env);
  const b = {
    usage_provider_id: "c4o6",
    config_version: v,
    providers: [{ config: { apiKey: "sk-a", baseUrl: "https://a.example.com" }, enabled: true, type: "openai", id: "c4o6" }],
  };
  assert.equal(getProviderFleet(b, env), f1, "key order must not trigger rebuild");
});

test("C4: version bump and env rotation still rebuild; same version+content still reuses", () => {
  const env = {};
  const mk = (version) => ({ config_version: version, providers: [] });
  const f1 = getProviderFleet(mk(71007), env);
  assert.equal(getProviderFleet(mk(71007), env), f1, "same version+content must reuse");
  assert.notEqual(getProviderFleet(mk(71008), env), f1, "version bump must rebuild");
  const f2 = getProviderFleet(mk(71009), env);
  assert.notEqual(getProviderFleet(mk(71009), {}), f2, "env identity rotation must rebuild");
});

test("C4: no-version configs fall back to reference equality", () => {
  const env = {};
  const a = { providers: [] };
  const f1 = getProviderFleet(a, env);
  assert.equal(getProviderFleet(a, env), f1, "same reference must reuse");
  assert.notEqual(getProviderFleet({ providers: [] }, env), f1, "new object without version must rebuild");
});

test("C4: toFleetConfig/fleetConfigEquals is the single rebuild rule", () => {
  const env = {};
  const a = { config_version: 71010, providers: [openaiProvider("c4x", { apiKey: "sk-a" })] };
  const same = { config_version: 71010, providers: [openaiProvider("c4x", { apiKey: "sk-a" })] };
  const drifted = { config_version: 71010, providers: [openaiProvider("c4x", { apiKey: "sk-b" })] };
  const bumped = { config_version: 71011, providers: [openaiProvider("c4x", { apiKey: "sk-a" })] };
  const fa = toFleetConfig(a, env);
  assert.equal(fleetConfigEquals(fa, toFleetConfig(same, env)), true, "equal content must be equal");
  assert.equal(fleetConfigEquals(fa, toFleetConfig(drifted, env)), false, "credential drift must not be equal");
  assert.equal(fleetConfigEquals(fa, toFleetConfig(bumped, env)), false, "version bump must not be equal");
  assert.equal(fleetConfigEquals(fa, toFleetConfig(a, {})), false, "env rotation must not be equal");
  assert.equal(fleetConfigEquals(null, toFleetConfig(a, env)), false, "null prev must not be equal");
});

test("C4: getBalance normalization preserved (non-numeric success is unsupported)", async () => {
  const fleet = new ProviderFleet(
    { providers: [openaiProvider("c4norm-a", {})], usage_provider_id: "c4norm-a" },
    {},
  );
  fleet.getProvider("c4norm-a").getBalance = async () => ({ success: true, data: { foo: 1 } });
  const res = await fleet.getBalance("c4norm-a");
  assert.equal(res.success, false, "success without numeric balance must normalize to false");
  assert.equal(res.balance, 0);
});

test("C4: getBalance success caching preserved (one upstream call for two reads)", async () => {
  const fleet = new ProviderFleet(
    { providers: [openaiProvider("c4cache-b", {})], usage_provider_id: "c4cache-b" },
    {},
  );
  let upstreamCalls = 0;
  fleet.getProvider("c4cache-b").getBalance = async () => {
    upstreamCalls++;
    return { success: true, balance: 7, total: 70 };
  };
  const first = await fleet.getBalance("c4cache-b");
  const second = await fleet.getBalance("c4cache-b");
  assert.equal(upstreamCalls, 1, "second read must be served from cache");
  assert.equal(first, second);
  assert.equal(second.balance, 7);
});
