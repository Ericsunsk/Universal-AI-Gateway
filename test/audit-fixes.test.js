import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceOpenAIChunkAll, formatOpenAIToAnthropicJson } from "../src/exchange/stream.js";
import { dispatchExchange } from "../src/exchange/exchange.js";
import { needsReasoningScrub, hasCallChat, hasCallMessages } from "../src/core/contract.js";
import { parseReasoningIntent } from "../src/exchange/reasoning.js";
import { authenticateAccess } from "../src/auth/auth.js";
import { getDefaultConfig } from "../src/config/config.js";
import { AnthropicStandardProvider } from "../src/providers/anthropic_standard.js";
import { OpenAIStandardProvider } from "../src/providers/openai_standard.js";

// P0-1：非流式无 id 续片按序合并，不再丢弃
test("non-streaming SSE tool frags without id merge by order", async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] } }] })}\n\n`,
  ];
  const body = new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    }
  });
  const res = await formatOpenAIToAnthropicJson(new Response(body), "m");
  const json = await res.json();
  const tool = json.content.find((b) => b.type === "tool_use");
  assert.ok(tool, "tool_use survives id-less continuation");
  assert.deepEqual(tool.input, { a: 1 });
});

// P0-2：耗尽收尾携带 lastFail 证据
test("dispatchExchange exhausted message includes lastFail evidence", async () => {
  const mockFleet = {
    getAllActive: () => [{ id: "bad" }],
    getProvider: () => ({
      id: "bad",
      callChat: async () => new Response("upstream says quota gone", { status: 429 })
    })
  };
  const res = await dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "bad", model: "m" }] } },
    fleet: mockFleet,
    protocol: "openai"
  });
  // 单候选耗尽：直接返回 lastFail 预渲染响应，证据不得丢失
  assert.equal(res.status, 429);
  const text = await res.text();
  assert.ok(text.includes("quota gone"));
});

// P0-4：方言判定走能力谓词，不 switch type
test("needsReasoningScrub prefers explicit dialect over type tag", () => {
  assert.equal(needsReasoningScrub({ type: "workbuddy" }), true);
  assert.equal(needsReasoningScrub({ type: "openai" }), false);
  assert.equal(needsReasoningScrub({ type: "custom", reasoningDialect: "workbuddy" }), true);
  assert.equal(needsReasoningScrub(null), false);
});

// P0-5：Anthropic provider 无 callChat stub；OpenAI+Anthropic 组合显式 400
test("anthropic provider exposes only callMessages; openai protocol gets clear 400", async () => {
  const p = new AnthropicStandardProvider({ id: "a", config: {} }, {});
  assert.equal(hasCallMessages(p), true);
  assert.equal(hasCallChat(p), false);
  const mockFleet = {
    getAllActive: () => [{ id: "a" }],
    getProvider: () => p
  };
  const res = await dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "a", model: "m" }] } },
    fleet: mockFleet,
    protocol: "openai"
  });
  assert.equal(res.status, 400);
});

// 推理后缀：多层叠加循环剥离
test("parseReasoningIntent strips stacked suffixes", () => {
  const r = parseReasoningIntent({ model: "m[high][200k]", body: {} });
  assert.equal(r.cleanModel, "m");
  assert.equal(r.level, "high");
});

// 鉴权门：后缀模型同样放行 + 原型链 key 不污染语义
test("auth model gate strips reasoning suffix; proto keys are 401 not 403", () => {
  const cfg = {
    master_key: "master",
    virtual_keys: { k1: { enabled: true, models: ["m"] } }
  };
  const req = (model) => ({
    headers: new Headers({ Authorization: "Bearer k1" })
  });
  assert.equal(authenticateAccess(req(), cfg, { model: "m[high]" }).ok, true);
  const proto = authenticateAccess(
    { headers: new Headers({ Authorization: "Bearer __proto__" }) }, cfg
  );
  assert.equal(proto.ok, false);
  assert.equal(proto.response.status, 401);
});

// M4：上游 URL 拒绝内网/明文
test("standard providers refuse non-public upstream URLs", async () => {
  const oai = new OpenAIStandardProvider({ id: "o", config: { baseUrl: "http://169.254.169.254/x" } }, {});
  await assert.rejects(() => oai.callChat({}), /non-public/);
  const ant = new AnthropicStandardProvider({ id: "a", config: { baseUrl: "https://api.anthropic.com" } }, {});
  assert.ok(ant.baseUrl.startsWith("https://"));
});

test("urlGuard blocks private hosts, allows public https", async () => {
  const { isPrivateHostname, assertPublicHttps } = await import("../src/providers/urlGuard.js");
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "0.0.0.0", "svc.local", "svc.internal"]) {
    assert.equal(isPrivateHostname(h), true, h);
  }
  assert.equal(isPrivateHostname("172.15.0.1"), false, "172.15 is public");
  assert.equal(isPrivateHostname("172.32.0.1"), false, "172.32 is public");
  assert.equal(isPrivateHostname("api.anthropic.com"), false);
  assert.throws(() => assertPublicHttps("http://api.openai.com/v1", "t"), /non-public/);
  assert.ok(assertPublicHttps("https://api.openai.com/v1", "t"));
});

// Fleet：不 bump 版本、只加 provider 也重建
test("getProviderFleet rebuilds when providers change without version bump", async () => {
  const { getProviderFleet } = await import("../src/core/fleet.js");
  const env = {};
  const v = Date.now();
  const a = { config_version: v, providers: [] };
  const f1 = getProviderFleet(a, env);
  const b = {
    config_version: v,
    providers: [{ id: "n", type: "openai", enabled: true, config: {} }]
  };
  assert.notEqual(getProviderFleet(b, env), f1);
});

// MASTER fail-closed：缺失即随机值
test("missing MASTER_KEY never equals API_KEY", () => {
  const cfg = getDefaultConfig({ API_KEY: "ak" });
  assert.notEqual(cfg.master_key, "ak");
});

// reduce：无 delta 终局 chunk 保留 finish
test("reduce keeps finish for delta-less stop chunk", () => {
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [{ finish_reason: "stop" }] }), [
    { kind: "finish", finishReason: "stop" }
  ]);
});

// L5：裸 Authorization（无 Bearer 前缀）一律 401，不再兼容
test("bare Authorization header without Bearer prefix is rejected", () => {
  const cfg = { master_key: "master", virtual_keys: { k1: { enabled: true, models: ["*"] } } };
  const bare = authenticateAccess(
    { headers: new Headers({ Authorization: "k1" }) }, cfg
  );
  assert.equal(bare.ok, false);
  assert.equal(bare.response.status, 401);
  // x-api-key 仍可用
  const viaHeader = authenticateAccess(
    { headers: new Headers({ "x-api-key": "k1" }) }, cfg
  );
  assert.equal(viaHeader.ok, true);
});

// L4：dispatch 归因头仅 master 可见
test("dispatch debug headers are master-only", async () => {
  const mk = (principal) => ({
    getAllActive: () => [{ id: "wb" }],
    getProvider: () => ({
      id: "wb",
      type: "workbuddy",
      reasoningDialect: "workbuddy",
      callChat: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200, headers: { "Content-Type": "application/json" }
      })
    }),
    _principal: principal
  });
  const run = (principal) => dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "wb", model: "m" }] } },
    fleet: mk(principal),
    protocol: "openai",
    principal
  });
  const masterRes = await run({ isMaster: true, role: "admin" });
  assert.equal(masterRes.headers.get("X-Gateway-Model"), "m");
  const clientRes = await run({ isMaster: false, role: "client" });
  assert.equal(clientRes.headers.get("X-Gateway-Model"), null);
  assert.equal(clientRes.headers.get("X-Gateway-Account"), null);
  assert.equal(clientRes.headers.get("X-Gateway-Fallback"), null);
});
