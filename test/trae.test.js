import { test } from "node:test";
import assert from "node:assert/strict";
import { TraeProvider, classifyTrae, TRAE_APP_ID, TRAE_CLIENT_ID } from "../src/providers/trae.js";
import { createProvider } from "../src/providers/index.js";
import { redactConfig } from "../src/config/config.js";

// ---- 错误分类（Trae 特定） ----
test("classifyTrae: 429 → cooldown", () => {
  assert.equal(classifyTrae(429), "cooldown");
});

test("classifyTrae: 5xx → retry (no punishment)", () => {
  assert.equal(classifyTrae(500), "retry");
  assert.equal(classifyTrae(503), "retry");
});

test("classifyTrae: 401/403 and quota/safety keywords → cooldown", () => {
  assert.equal(classifyTrae(401), "cooldown");
  assert.equal(classifyTrae(403), "cooldown");
  assert.equal(classifyTrae(200, "insufficient quota"), "cooldown");
  assert.equal(classifyTrae(200, "rate limit exceeded"), "cooldown");
  assert.equal(classifyTrae(200, "触发频率限制"), "cooldown");
  assert.equal(classifyTrae(200, "余额不足"), "cooldown");
  assert.equal(classifyTrae(200, "安全审核拦截"), "cooldown");
  assert.equal(classifyTrae(200, "safety compliance"), "cooldown");
});

test("classifyTrae: other errors → fatal", () => {
  assert.equal(classifyTrae(400), "fatal");
  assert.equal(classifyTrae(404), "fatal");
  assert.equal(classifyTrae(200, "some normal message"), "fatal");
});

// ---- 账号池解析 ----
test("getAccounts: single account via accessToken", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: { accessToken: "tok" } }, {});
  const accounts = p.getAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "default");
  assert.equal(accounts[0].accessToken, "tok");
});

test("getAccounts: multi-account pool respects enabled flag", () => {
  const p = new TraeProvider({
    id: "trae",
    type: "trae",
    config: {
      accounts: [
        { id: "a", accessToken: "t1", enabled: true },
        { id: "b", accessToken: "t2", enabled: false },
        { id: "c", accessToken: "t3" }
      ]
    }
  }, {});
  const ids = p.getAccounts().map((a) => a.id);
  assert.deepEqual(ids, ["a", "c"]);
});

test("getAccounts: empty when no token", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: {} }, {});
  assert.equal(p.getAccounts().length, 0);
});

// ---- 网关与 appId ----
test("default appId is the live-confirmed production id (677332)", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: {} }, {});
  assert.equal(p.appId, "677332");
  assert.equal(p.appId, TRAE_APP_ID);
  assert.equal(TRAE_CLIENT_ID, "ono9krqynydwx5");
});

test("chatHost/usageHost default to core/grow traeapi.us, overridable", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: {} }, {});
  assert.equal(p.chatHost, "https://core-normal.traeapi.us");
  assert.equal(p.usageHost, "https://grow-normal.traeapi.us");
  assert.equal(p.chatPath, "/api/ide/v1/super_completion");
  assert.equal(p.payStatusPath, "/trae/api/v1/pay/ide_user_pay_status");

  const q = new TraeProvider({
    id: "trae",
    type: "trae",
    config: { chatHost: "https://example.com", usageHost: "https://usage.example.com" }
  }, {});
  assert.equal(q.chatHost, "https://example.com");
  assert.equal(q.usageHost, "https://usage.example.com");
});

// ---- 请求头（设备指纹）----
test("buildHeaders carries TTNetwork UA, appId, and device fingerprint", () => {
  const p = new TraeProvider({
    id: "trae", type: "trae",
    config: { deviceId: "did-1", machineId: "mid-1", deviceBrand: "MacBookPro17,1" }
  }, {});
  const h = p.buildHeaders("tok-123", {});
  assert.equal(h["User-Agent"], "TTNetwork PC");
  assert.equal(h["xAppId"], "677332");
  assert.equal(h["Authorization"], "Bearer tok-123");
  assert.equal(h["X-Device-Id"], "did-1");
  assert.equal(h["X-Machine-Id"], "mid-1");
  assert.equal(h["X-Device-Brand"], "MacBookPro17,1");
  assert.equal(h["Accept"], "text/event-stream");
});

test("buildHeaders prefers account-level device id over config-level", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: { deviceId: "config-did" } }, {});
  const h = p.buildHeaders("tok", { deviceId: "account-did" });
  assert.equal(h["X-Device-Id"], "account-did");
});

// ---- payload 构造 ----
test("buildPayload maps OpenAI payload to super_completion context", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: {} }, {});
  const out = p.buildPayload({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }] });
  assert.equal(out.model, "deepseek-v4");
  assert.equal(out.prompt.length, 1);
  assert.equal(out.prompt[0].content, "hi");
  assert.equal(out.context, undefined);
});

test("buildPayload forwards context and workspacePath when present", () => {
  const p = new TraeProvider({ id: "trae", type: "trae", config: {} }, {});
  const out = p.buildPayload({ model: "m", messages: [], context: { cursor: 1 }, workspacePath: "/tmp/x" });
  assert.deepEqual(out.context, { cursor: 1 });
  assert.equal(out.workspace_path, "/tmp/x");
});

// ---- provider 注册 ----
test("createProvider registers type=trae", () => {
  const p = createProvider({ id: "trae", type: "trae", config: { accessToken: "x" } }, {});
  assert.equal(p.type, "trae");
  assert.equal(p.name, "Trae");
});

// ---- 机密脱敏 ----
test("redactConfig hides Trae jwtToken (jwtToken alias must not leak)", () => {
  const full = {
    providers: [{ id: "trae", type: "trae", config: { jwtToken: "JWT-SECRET-LEAK", appId: TRAE_APP_ID } }]
  };
  const dump = JSON.stringify(redactConfig(full));
  assert.ok(!dump.includes("JWT-SECRET-LEAK"), "jwtToken must be redacted");
  assert.ok(dump.includes("***REDACTED***"), "redaction marker present");
});

// ---- Token 刷新与 Fleet 兼容 ----
test("refreshAccessToken without args iterates all accounts without throwing", async () => {
  const p = new TraeProvider({
    id: "trae",
    type: "trae",
    config: {
      accounts: [
        { id: "acc-1", accessToken: "t1" },
        { id: "acc-2", accessToken: "t2" }
      ]
    }
  }, {});
  // 无 refreshToken 时回退到 existing token，不发起远程 fetch 也不报错
  const res = await p.refreshAccessToken();
  assert.deepEqual(res, ["t1", "t2"]);
});

