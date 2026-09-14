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
