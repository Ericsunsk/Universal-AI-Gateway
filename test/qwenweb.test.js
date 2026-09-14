import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseChatNew,
  splitHistory,
  buildTurn,
  buildCompletionsBody,
  parseQwenSSEObject,
  isWAFStatus,
  isWAFBody
} from "../src/providers/qwenweb/protocol.js";
import { buildQwenHeaders } from "../src/providers/qwenweb/fingerprint.js";
import { QwenWebProvider } from "../src/providers/qwenweb/index.js";

test("splitHistory folds system and drops tool roles", () => {
  const { systemPrefix, turns } = splitHistory([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "tool", content: "x" },
    { role: "assistant", content: "yo" }
  ]);
  assert.equal(systemPrefix, "sys");
  assert.deepEqual(turns.map(t => t.role), ["user", "assistant"]);
});

test("buildTurn prefixes system once and chains parent", () => {
  const t = buildTurn({ role: "user", content: "hi" }, "qwen3.7-plus", { systemPrefix: "SYS", parentId: "p0", fid: "f1" });
  assert.equal(t.content, "SYS\nhi");
  assert.equal(t.parentId, "p0");
  assert.equal(t.parent_id, "p0");
  assert.equal(t.fid, "f1");
  assert.ok(Array.isArray(t.childrenIds) && t.childrenIds.length === 1);
});

test("buildCompletionsBody carries captured wire fields", () => {
  const b = buildCompletionsBody({ chatId: "c1", parentId: null, model: "m", turn: { content: "x" } });
  assert.equal(b.stream, true);
  assert.equal(b.version, "2.1");
  assert.equal(b.incremental_output, true);
  assert.equal(b.chat_id, "c1");
  assert.equal(b.model, "m");
});

test("parseChatNew tolerates envelope variants", () => {
  assert.equal(parseChatNew({ chat_id: "a" }), "a");
  assert.equal(parseChatNew({ data: { chat_id: "b" } }), "b");
  assert.equal(parseChatNew({ id: "c" }), "c");
  assert.equal(parseChatNew({}), null);
  assert.equal(parseChatNew(null), null);
});

test("parseQwenSSEObject covers documented shapes", () => {
  assert.deepEqual(parseQwenSSEObject({ type: "reasoning", data: "r" }).kind, "reasoning");
  assert.deepEqual(parseQwenSSEObject({ phase: "answer", data: "t" }), { kind: "content", text: "t", responseId: null });
  assert.equal(parseQwenSSEObject({ type: "done" }).kind, "done");
  assert.equal(parseQwenSSEObject({ choices: [{ delta: { content: "x" } }] }).kind, "content");
  assert.equal(parseQwenSSEObject({ choices: [{ delta: { reasoning_content: "y" } }] }).kind, "reasoning");
  assert.equal(parseQwenSSEObject({ choices: [{ finish_reason: "stop" }] }).kind, "done");
  assert.equal(parseQwenSSEObject({}).kind, "unknown");
});

test("WAF detectors catch status and body signatures", () => {
  assert.equal(isWAFStatus(403), true);
  assert.equal(isWAFStatus(302), true);
  assert.equal(isWAFStatus(429), true);
  assert.equal(isWAFStatus(200), false);
  assert.equal(isWAFBody("<html>aliyun_waf challenge"), true);
  assert.equal(isWAFBody("请拖动滑块完成拼图"), true);
  assert.equal(isWAFBody('{"choices":[]}'), false);
});

test("buildQwenHeaders replays fingerprint and mints request id", () => {
  const h = buildQwenHeaders({ fingerprint: { umidtoken: "u", ua: "b", cookie: "c=1" } });
  assert.equal(h["bx-umidtoken"], "u");
  assert.equal(h["bx-ua"], "b");
  assert.equal(h["Cookie"], "c=1");
  assert.equal(h["source"], "web");
  assert.ok(h["X-Request-Id"]);
  const h2 = buildQwenHeaders({});
  assert.equal(h2["bx-umidtoken"], undefined);
  assert.ok(h2["X-Request-Id"]);
});

function sseResponse(lines, status = 200, contentType = "text/event-stream") {
  const body = lines.join("\n") + "\n";
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function mockFetch(routes) {
  return async (url, init = {}) => {
    const key = `${init.method || "GET"} ${String(url).split("?")[0]}`;
    const hit = routes[key];
    if (!hit) throw new Error(`unexpected fetch: ${key}`);
    if (typeof hit === "function") return hit(url, init);
    return hit;
  };
}

test("provider streams qwen content as OpenAI chunks", async () => {
  const fetchImpl = mockFetch({
    "POST https://chat.qwen.ai/api/v2/chats/new": sseResponse(['{"chat_id":"c1"}'], 200, "application/json"),
    "POST https://chat.qwen.ai/api/v2/chat/completions": sseResponse([
      'data: {"type":"reasoning","data":"th","response_id":"r1"}',
      'data: {"type":"content","data":"QWEN-OK","response_id":"r1"}',
      'data: {"type":"done","response_id":"r1"}'
    ])
  });
  const p = new QwenWebProvider({ id: "qwenweb", config: { cookie: "c=1" } }, {});
  const res = await p.callChat(
    { model: "qwen3.7-plus", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] },
    { fetch: fetchImpl }
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes("QWEN-OK"), "content chunk forwarded");
  assert.ok(text.includes("reasoning_content"), "thinking mapped to reasoning_content");
  assert.ok(text.includes("[DONE]"));
});

test("provider maps WAF challenge to 429 for gateway cooldown", async () => {
  const fetchImpl = mockFetch({
    "POST https://chat.qwen.ai/api/v2/chats/new":
      new Response("<html>aliyun_waf</html>", { status: 200, headers: { "Content-Type": "text/html" } })
  });
  const p = new QwenWebProvider({ id: "qwenweb", config: {} }, {});
  const res = await p.callChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { fetch: fetchImpl });
  assert.equal(res.status, 429);
});

test("provider rejects empty turns with 400", async () => {
  const p = new QwenWebProvider({ id: "qwenweb", config: {} }, {});
  const res = await p.callChat({ model: "m", messages: [] }, { fetch: async () => { throw new Error("must not fetch"); } });
  assert.equal(res.status, 400);
});

test("truncateHistory keeps system and most recent turns", async () => {
  const { truncateHistory, QWENWEB_MAX_TURNS } = await import("../src/providers/qwenweb/protocol.js");
  const turns = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }));
  const out = truncateHistory("SYS", turns);
  assert.equal(out.systemPrefix, "SYS");
  assert.equal(out.turns.length, QWENWEB_MAX_TURNS);
  assert.equal(out.turns[0].content, "t5");
  assert.equal(out.turns[out.turns.length - 1].content, "t24");
  const short = truncateHistory("SYS", turns.slice(0, 3));
  assert.equal(short.turns.length, 3, "short history untouched");
});

test("parseQwenSSEObject replays live fixture end to end", async () => {
  const fs = await import("node:fs");
  const { parseQwenSSEObject } = await import("../src/providers/qwenweb/protocol.js");
  const raw = fs.readFileSync("test/fixtures/qwen-sse-answer.txt", "utf8");
  const kinds = [];
  let reasoning = "", content = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const body = t.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    const ev = parseQwenSSEObject(JSON.parse(body));
    kinds.push(ev.kind);
    if (ev.kind === "reasoning") reasoning += ev.text || "";
    if (ev.kind === "content") content += ev.text || "";
  }
  assert.deepEqual(kinds, ["unknown", "reasoning", "unknown", "content", "content", "unknown", "unknown", "done"]);
  assert.ok(reasoning.includes("one hundred forty-four"), "thinking text from summary_thought");
  assert.ok(content.includes("144"), "answer text joined");
});

test("antiBot matches Python golden vectors bit-exactly", async () => {
  const fs = await import("node:fs");
  const { lzwCompress, customEncode, generateCookies, generateBxUa, generateFingerprint, CUSTOM_BASE64_CHARS } =
    await import("../src/providers/qwenweb/antiBot.js");
  const golden = JSON.parse(fs.readFileSync("test/fixtures/qwen-antibot-golden.json", "utf8"));
  // LZW + 自定义 base64：固定输入必须逐字节一致
  const charFunc = (i) => CUSTOM_BASE64_CHARS[i];
  assert.equal(lzwCompress("hello world hello", 6, charFunc), golden.lzw1);
  assert.equal(customEncode("ABAABAABAABAAB", true), golden.lzw2);
  // cookies：用黄金 fp 输入 + 与 Python 同步的随机序列（fp 消耗前 6 个，cookies 从第 7 个起）
  const cycle = [77, 88, 99, 123456789, 987654321, 42424242];
  let pos = 0;
  const randInt = (min, max) => cycle[pos++ % cycle.length] % (max - min + 1) + min;
  const ck = generateCookies(golden.fp, { randInt, now: () => 1789000000000 });
  assert.equal(ck.ssxmod_itna, golden.ck0);
  assert.equal(ck.ssxmod_itna2, golden.ck1);
  // bx-ua：同 fp + 同 timestamp + 同 rnd（Python 侧 7777777→2777），AES/sha256/md5 必须逐字节一致
  assert.equal(generateBxUa(golden.fp, { timestamp: 1789000000000, rnd: 2777 }), golden.bx);
  // 指纹结构：37 段 + 固定槽位
  const parts = golden.fp.split("^");
  assert.equal(parts.length, 37);
  assert.equal(generateFingerprint({ deviceId: "x" }).split("^").length, 37);
});

test("assembleRequestHeaders builds complete anti-bot identity", async () => {
  const { assembleRequestHeaders, uuid4 } = await import("../src/providers/qwenweb/antiBot.js");
  assert.match(uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const { headers } = assembleRequestHeaders({ deviceId: "testdevice0000000001", token: "tok", umidtoken: "mid" });
  assert.ok(headers["Cookie"].startsWith("ssxmod_itna=1-"));
  assert.ok(headers["bx-ua"].startsWith("231!"));
  assert.equal(headers["bx-umidtoken"], "mid");
  assert.equal(headers["Authorization"], "Bearer tok");
  assert.equal(headers["bx-v"], "2.5.37");
  assert.equal(headers["source"], "web");
  const bare = assembleRequestHeaders({ deviceId: "testdevice0000000001" }).headers;
  assert.equal(bare["bx-umidtoken"], undefined);
  assert.equal(bare["Authorization"], undefined);
});

test("provider auto-fingerprint path works without stored cookies", async () => {
  const { QwenWebProvider } = await import("../src/providers/qwenweb/index.js");
  let umidFetched = false;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("sg-wum.alibaba.com")) {
      umidFetched = true;
      return new Response("__fycb('MID123')");
    }
    if (u.includes("/api/v2/chats/new")) {
      const auth = init.headers["Authorization"];
      if (auth !== "Bearer tok123") throw new Error("token must be forwarded, got: " + auth);
      if (!init.headers["bx-ua"]?.startsWith("231!")) throw new Error("bx-ua must be generated");
      if (!init.headers["Cookie"]?.includes("ssxmod_itna=1-")) throw new Error("cookies must be generated");
      if (init.headers["bx-umidtoken"] !== "MID123") throw new Error("umidtoken must be attached");
      return new Response('{"chat_id":"c9"}', { headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/api/v2/chat/completions")) {
      return new Response('data: {"type":"content","data":"AUTO-OK"}\n\ndata: {"type":"done"}\n\n', {
        headers: { "Content-Type": "text/event-stream" }
      });
    }
    throw new Error("unexpected: " + u);
  };
  const p = new QwenWebProvider({ id: "qw", config: { token: "tok123" } }, {});
  const res = await p.callChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { fetch: fetchImpl });
  assert.equal(res.status, 200);
  assert.ok(umidFetched, "umidtoken fetched once");
  const text = await res.text();
  assert.ok(text.includes("AUTO-OK"));
});

test("provider maps JSON business-error body to WAF 429 instead of empty 200", async () => {
  const { QwenWebProvider } = await import("../src/providers/qwenweb/index.js");
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/v2/chats/new")) {
      return new Response('{"chat_id":"c1"}', { headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      '{"ret":["FAIL_SYS_USER_VALIDATE","RGV587_ERROR::SM::busy"],"data":{"url":"https://x/_____tmd_____/punish?x5secdata=1"}}',
      { status: 200, headers: { "Content-Type": "application/json;charset=UTF-8" } }
    );
  };
  const p = new QwenWebProvider({ id: "qw", config: { token: "t" } }, {});
  const res = await p.callChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { fetch: fetchImpl });
  assert.equal(res.status, 429, "challenge JSON must cool down, never stream empty 200");
});

test("provider deviceId is deterministic per provider id", async () => {
  const { QwenWebProvider } = await import("../src/providers/qwenweb/index.js");
  const a = new QwenWebProvider({ id: "qw-same", config: {} }, {});
  const b = new QwenWebProvider({ id: "qw-same", config: {} }, {});
  const c = new QwenWebProvider({ id: "qw-other", config: {} }, {});
  assert.equal(a.deviceId, b.deviceId, "stable across restarts");
  assert.notEqual(a.deviceId, c.deviceId, "distinct per account");
  assert.match(a.deviceId, /^[0-9a-f]{20}$/);
});

test("ensureIdentity reuses fresh KV identity and mints when stale", async () => {
  const { QwenWebProvider } = await import("../src/providers/qwenweb/index.js");
  const store = new Map();
  const kv = {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => store.set(k, v),
    delete: async (k) => { store.delete(k); }
  };
  const env = { GATEWAY_KV: kv };
  const p = new QwenWebProvider({ id: "qw-ident", config: { token: "t" } }, env);
  const neverFetch = async () => { throw new Error("no network expected"); };
  const fresh = { cookie: "c=1", bxua: "231!x", umidtoken: null, deviceId: "d", mintedAt: Date.now() };
  store.set("QWEN_FP_qw-ident", JSON.stringify(fresh));
  const hit = await p.ensureIdentity(neverFetch);
  assert.equal(hit.cookie, "c=1", "fresh KV identity reused without minting");
  store.set("QWEN_FP_qw-ident", JSON.stringify({ ...fresh, mintedAt: Date.now() - 20 * 60 * 1000 }));
  const p2 = new QwenWebProvider({ id: "qw-ident", config: { token: "t" } }, env);
  const minted = await p2.ensureIdentity(neverFetch);
  assert.ok(minted.cookie.startsWith("ssxmod_itna=1-"), "stale identity reminted locally");
  assert.ok(minted.bxua.startsWith("231!"));
  assert.ok(JSON.parse(store.get("QWEN_FP_qw-ident")).cookie.startsWith("ssxmod_itna=1-"), "remint written through to KV");
});

test("onSchedule skips without token and mints with token", async () => {
  const { QwenWebProvider } = await import("../src/providers/qwenweb/index.js");
  const env = {};
  const skip = await new QwenWebProvider({ id: "qw-naked", config: {} }, env).onSchedule();
  assert.equal(skip.success, false);
});
