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

// 非十进制 / 混合进制 IPv4 字面量：字符串前缀匹配拦不住，必须在 URL 解析层归一化后判定。
// 这些原样匹配既不是 127.* 也不是 169.254.*，但解析后就是回环 / 云 metadata。
test("urlGuard blocks encoded-literal IP bypasses that defeat string prefix matching", async () => {
  const { assertPublicHttps } = await import("../src/providers/urlGuard.js");
  const encoded = [
    "https://2852039166/",        // 十进制 -> 169.254.169.254（云 metadata）
    "https://2130706433/",        // 十进制 -> 127.0.0.1
    "https://0x7f000001/",        // 十六进制
    "https://0177.0.0.1/",        // 八进制
    "https://0x7f.0.0.1/",        // 混合进制
    "https://127.1/",             // 短式回环
  ];
  for (const u of encoded) {
    assert.throws(() => assertPublicHttps(u, "t"), /non-public/, `${u} must be refused`);
  }
  // 尾部点 / IPv6 包裹形态
  assert.throws(() => assertPublicHttps("https://10.0.0.1./", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://[::ffff:127.0.0.1]/", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://[::ffff:169.254.169.254]/", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://[::ffff:7f00:1]/", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://[::1]/", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://[fc00::1]/", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://[fe80::1]/", "t"), /non-public/);
  // CGNAT 100.64/10
  assert.throws(() => assertPublicHttps("https://100.64.0.1/", "t"), /non-public/);
  assert.throws(() => assertPublicHttps("https://100.127.255.255/", "t"), /non-public/);
});

// RFC 6890 特殊用途地址中不可全局路由的全部区间：护栏必须 fail-closed。
// 仅拦 RFC1918 三段是不够的 —— 组播/保留段同样可被用作探测跳板。
test("urlGuard blocks all non-globally-routable IPv4 ranges (RFC 6890)", async () => {
  const { isPrivateHostname } = await import("../src/providers/urlGuard.js");
  const blocked = {
    "0.0.0.0/8": "0.1.2.3",
    "10.0.0.0/8": "10.1.2.3",
    "100.64.0.0/10": "100.64.1.1",
    "127.0.0.0/8": "127.0.0.1",
    "169.254.0.0/16": "169.254.169.254",
    "172.16.0.0/12": "172.16.1.1",
    "192.0.0.0/24": "192.0.0.1",
    "192.0.2.0/24": "192.0.2.1",
    "192.88.99.0/24": "192.88.99.1",
    "192.168.0.0/16": "192.168.1.1",
    "198.18.0.0/15": "198.18.1.1",
    "198.51.100.0/24": "198.51.100.1",
    "203.0.113.0/24": "203.0.113.1",
    "224.0.0.0/4": "224.0.0.1",
    "240.0.0.0/4": "240.0.0.1",
    "255.255.255.255": "255.255.255.255",
  };
  for (const [cidr, ip] of Object.entries(blocked)) {
    assert.equal(isPrivateHostname(ip), true, `${ip} (${cidr}) must be blocked`);
  }
});

test("urlGuard blocks IPv6 non-routable ranges by hextet, not string prefix", async () => {
  const { isPrivateHostname } = await import("../src/providers/urlGuard.js");
  for (const h of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1",
    "ff02::1", "ff00::1", "2001:db8::1", "2002::1",
    "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::ffff:7f00:1"]) {
    assert.equal(isPrivateHostname(h), true, `${h} must be blocked`);
  }
  // fec0::/10 已弃用的 site-local 不在 fe80::/10 内，且非保留 -> 不应误杀
  for (const h of ["fec0::1", "fbff::1", "2606:4700::1111", "2400:cb00::1"]) {
    assert.equal(isPrivateHostname(h), false, `${h} must not be blocked`);
  }
});

// 段边界必须精确：相邻的公网地址不能被误杀，否则合法上游会被拒。
test("urlGuard range boundaries are exact (no off-by-one)", async () => {
  const { isPrivateHostname } = await import("../src/providers/urlGuard.js");
  const publicNeighbors = [
    "172.15.255.255", "172.32.0.0",         // 172.16/12 两侧
    "100.63.255.255", "100.128.0.0",        // 100.64/10 两侧
    "169.253.255.255", "169.255.0.0",       // 169.254/16 两侧
    "192.0.1.1", "192.167.255.255", "192.169.0.0",  // 192.0/24 与 192.168/16 两侧
    "192.0.3.1", "192.88.98.255", "192.88.100.0",   // 192.0.2/24 与 192.88.99/24 两侧
    "198.17.255.255", "198.20.0.0",         // 198.18/15 两侧
    "198.51.99.255", "198.51.101.0",        // 198.51.100/24 两侧
    "203.0.112.255", "203.0.114.0",         // 203.0.113/24 两侧
    "223.255.255.255",                      // 224/4 下界之前
    "11.0.0.1", "8.8.8.8", "1.1.1.1",
  ];
  for (const h of publicNeighbors) {
    assert.equal(isPrivateHostname(h), false, `${h} is public and must be allowed`);
  }
});

// 修复不得误杀合法上游：边界值两侧都要放行或拦截正确。
test("urlGuard does not false-positive on legitimate public upstreams", async () => {
  const { isPrivateHostname, assertPublicHttps } = await import("../src/providers/urlGuard.js");
  for (const h of ["172.15.255.255", "172.32.0.0", "11.0.0.1", "169.253.0.1",
    "100.63.255.255", "100.128.0.0", "8.8.8.8"]) {
    assert.equal(isPrivateHostname(h), false, `${h} must be public`);
  }
  for (const u of ["https://api.openai.com/v1", "https://api.anthropic.com/v1",
    "https://open.bigmodel.cn/api/paas/v4", "https://[2606:4700::1111]/v1"]) {
    assert.ok(assertPublicHttps(u, "t"), `${u} must be allowed`);
  }
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
