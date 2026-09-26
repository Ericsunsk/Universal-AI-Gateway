import { test } from "node:test";
import assert from "node:assert/strict";
import {
  iterSseParsedChunks,
  streamOpenAIToAnthropic,
  formatOpenAIToAnthropicJson,
} from "../src/exchange/stream.js";
import { setLogSink } from "../src/logging/logger.js";

const enc = new TextEncoder();

// 按指定字节块切分投喂，模拟上游 TCP 分片
function sseResponse(pieces) {
  const body = new ReadableStream({
    start(c) {
      for (const p of pieces) c.enqueue(typeof p === "string" ? enc.encode(p) : p);
      c.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(reader, options) {
  const out = [];
  for await (const item of iterSseParsedChunks(reader, options)) out.push(item);
  return out;
}

// ---- 行源基本语义：data 过滤 / [DONE] 跳过 / 空行忽略 ----
test("iterSseParsedChunks yields parsed chunks, skips noise and [DONE]", async () => {
  const upstream = sseResponse([
    ': comment line\n\ndata: {"a":1}\n\ndata: [DONE]\nnot-data: x\n\ndata: {"b":2}\n',
  ]);
  const items = await collect(upstream.body.getReader());
  assert.deepEqual(items.map((i) => i.parsed), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(items.map((i) => i.rawLine), ['{"a":1}', '{"b":2}']);
});

// ---- 跨 read 分片的行重组（含逐字节投喂） ----
test("iterSseParsedChunks reassembles lines split across reads", async () => {
  const full = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n';
  const bytes = enc.encode(full);
  // 逐字节投喂：行缓冲必须跨 read 正确重组
  const pieces = Array.from(bytes, (b) => new Uint8Array([b]));
  const upstream = sseResponse(pieces);
  const items = await collect(upstream.body.getReader());
  assert.equal(items.length, 2);
  assert.equal(items[0].parsed.choices[0].delta.content, "Hello");
  assert.equal(items[1].parsed.choices[0].delta.content, " world");
});

// ---- 未成行尾巴经 tail 出口透出（单 JSON 回退用） ----
test("iterSseParsedChunks exposes unterminated remainder via tail", async () => {
  const upstream = sseResponse(['data: {"ok":true}\n', '{"choices":[{"message":{"content":"tail"}}]}']);
  const tail = { text: "" };
  const items = await collect(upstream.body.getReader(), { tail });
  assert.equal(items.length, 1);
  assert.equal(tail.text, '{"choices":[{"message":{"content":"tail"}}]}');
});

// ---- 坏行限流：至多 3 条告警，文案保留调用方措辞 ----
test("iterSseParsedChunks caps malformed-line warns at 3 with caller wording", async () => {
  const lines = [];
  setLogSink((line) => { lines.push(line); });
  try {
    const bad = Array.from({ length: 5 }, (_v, i) => `data: {broken-${i}\n`).join("") + 'data: {"ok":true}\n';
    const upstream = sseResponse([bad]);
    const items = await collect(upstream.body.getReader(), { warnMessage: "Skipping malformed SSE line (non-streaming)" });
    assert.equal(items.length, 1);
    const warns = lines.filter((l) => l.includes("Skipping malformed SSE line (non-streaming)"));
    assert.equal(warns.length, 3, "warn cap must stay at 3");
  } finally {
    setLogSink(null);
  }
});

// ---- 默认 decoder 与默认告警文案（流式措辞） ----
test("iterSseParsedChunks works without options (default decoder, streaming wording)", async () => {
  const lines = [];
  setLogSink((line) => { lines.push(line); });
  try {
    const upstream = sseResponse(['data: {oops\n', 'data: {"ok":1}\n']);
    const items = await collect(upstream.body.getReader());
    assert.deepEqual(items.map((i) => i.parsed), [{ ok: 1 }]);
    assert.ok(lines.some((l) => l.includes("Skipping malformed SSE line") && !l.includes("non-streaming")));
  } finally {
    setLogSink(null);
  }
});

// ---- onBytes 钩子：每批字节各调一次（含空块也透传，由调用方判定） ----
test("iterSseParsedChunks reports each read via onBytes", async () => {
  const upstream = sseResponse(["a", "b", "c"]);
  let calls = 0;
  let byteLen = 0;
  const tail = { text: "" };
  await collect(upstream.body.getReader(), {
    onBytes: (v) => { calls += 1; byteLen += v?.byteLength ?? 0; },
    tail,
  });
  assert.equal(calls, 3);
  assert.equal(byteLen, 3);
  assert.equal(tail.text, "abc");
});

// ---- 端到端：分片投喂下流式事件序列与 token 记账保持一致 ----
test("stream translator is stable under chunk-split delivery (thinking+text+usage)", async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "r1" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "c1" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7 } })}\n\n`,
    "data: [DONE]\n",
  ];
  const splitAt = (s, n) => [s.slice(0, n), s.slice(n)];
  const pieces = chunks.flatMap((c, i) => (i === 0 ? splitAt(c, 17) : [c]));
  const upstream = sseResponse(pieces);
  const resp = streamOpenAIToAnthropic(upstream, "m");
  const text = await resp.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const b = block.trim();
    if (!b || b.startsWith("event: ping")) continue;
    const lines = b.split("\n");
    events.push({
      event: lines.find((l) => l.startsWith("event: "))?.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith("data: "))?.slice(6)),
    });
  }
  const starts = events.filter((e) => e.event === "content_block_start").map((e) => e.data.content_block.type);
  assert.deepEqual(starts, ["thinking", "text"]);
  const msgDelta = events.find((e) => e.event === "message_delta");
  assert.equal(msgDelta.data.usage.output_tokens, 7);
  assert.equal(msgDelta.data.usage.input_tokens, 12);
  assert.equal(events[events.length - 1].event, "message_stop");
});

// ---- 端到端：非流式在分片投喂下同样落袋 tool_calls ----
test("non-streaming translator merges split tool_call fragments after refactor", async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cm' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: 'd":"ls"}' } }] } }] })}\n\n`,
    "data: [DONE]\n",
  ];
  // 第二个 chunk 从中间切断，跨 read 边界
  const cut = chunks[1];
  const pieces = [chunks[0], cut.slice(0, 23), cut.slice(23), chunks[2]];
  const resp = await formatOpenAIToAnthropicJson(sseResponse(pieces), "m");
  const body = await resp.json();
  const tool = body.content.find((c) => c.type === "tool_use");
  assert.ok(tool);
  assert.equal(tool.id, "call_1");
  assert.deepEqual(tool.input, { cmd: "ls" });
});

// ---- 稳健性：单 JSON 结尾带 \n 不再被错误吞掉 ----
test("iterSseParsedChunks preserves single JSON ending with newline via tail", async () => {
  const jsonWithNewline = JSON.stringify({ choices: [{ message: { content: "single json with newline" } }] }) + "\n";
  const upstream = sseResponse([jsonWithNewline]);
  const tail = { text: "" };
  const items = await collect(upstream.body.getReader(), { tail });
  assert.equal(items.length, 0);
  assert.ok(tail.text.includes("single json with newline"), "tail must not drop JSON terminated with newline");

  // 端到端非流式解析单 JSON 带换行符
  const resp = await formatOpenAIToAnthropicJson(sseResponse([jsonWithNewline]), "m");
  const body = await resp.json();
  assert.equal(body.content[0].text, "single json with newline");
});

// ---- 规范兼容性：支持 CRLF (\\r\\n) 格式的标准 SSE ----
test("iterSseParsedChunks handles CRLF (\\r\\n) SSE streams cleanly", async () => {
  const crlfStream = "data: {\"choices\":[{\"delta\":{\"content\":\"CRLF\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n";
  const upstream = sseResponse([crlfStream]);
  const items = await collect(upstream.body.getReader());
  assert.equal(items.length, 1);
  assert.equal(items[0].parsed.choices[0].delta.content, "CRLF");
});

// ---- 规范兼容性：处理跨 chunk 切分的 UTF-8 多字节字符 ----
test("iterSseParsedChunks handles multibyte UTF-8 split across chunks", async () => {
  const chineseText = "你好世界，宇宙网关";
  const jsonStr = `data: ${JSON.stringify({ choices: [{ delta: { content: chineseText } }] })}\n\n`;
  const bytes = enc.encode(jsonStr);
  // 从一个中文字符中间的字节切分 (每个中文字符通常占 3 字节)
  const cutPoint = jsonStr.indexOf("世界") + 1;
  const pieces = [bytes.slice(0, cutPoint), bytes.slice(cutPoint)];
  const upstream = sseResponse(pieces);
  const items = await collect(upstream.body.getReader());
  assert.equal(items.length, 1);
  assert.equal(items[0].parsed.choices[0].delta.content, chineseText);
});

// ---- 规范兼容性：正确解析内嵌换行符的标准 W3C 多行 JSON 数据 ----
test("iterSseParsedChunks correctly parses multiline SSE data containing newlines in JSON", async () => {
  const multilineData = "data: {\"choices\":[{\"delta\":{\"content\":\"line 1\\nline 2\"}}]}\n\n";
  const upstream = sseResponse([multilineData]);
  const items = await collect(upstream.body.getReader());
  assert.equal(items.length, 1);
  assert.equal(items[0].parsed.choices[0].delta.content, "line 1\nline 2");
});


