import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformAnthropicToOpenAI,
  normalizeOpenAIMessages,
  transformToolsToOpenAI
} from "../src/exchange/exchange.js";

// ---- 工具定义转译：Anthropic input_schema -> OpenAI function ----
test("transformToolsToOpenAI maps Anthropic tools to OpenAI functions", () => {
  const out = transformToolsToOpenAI([
    { name: "read_file", description: "读文件", input_schema: { type: "object", properties: { path: { type: "string" } } } }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "function");
  assert.equal(out[0].function.name, "read_file");
  assert.equal(out[0].function.parameters.type, "object");
  assert.equal(out[0].function.parameters.properties.path.type, "string");
});

test("transformToolsToOpenAI returns undefined for empty/non-array", () => {
  assert.equal(transformToolsToOpenAI([]), undefined);
  assert.equal(transformToolsToOpenAI(null), undefined);
  assert.equal(transformToolsToOpenAI(undefined), undefined);
});

// ---- 消息规范化：孤儿 tool 结果降级、缺失结果补齐（11148） ----
test("normalizeOpenAIMessages downgrades orphan tool result to user message", () => {
  const out = normalizeOpenAIMessages([
    { role: "tool", tool_call_id: "call_1", content: "orphan result" }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "[Tool Result: orphan result]");
});

test("normalizeOpenAIMessages mounts tool results directly after their assistant tool_calls", () => {
  const out = normalizeOpenAIMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "r1" }
  ]);
  // assistant 在前，其 tool 结果紧跟其后
  assert.equal(out[0].role, "assistant");
  assert.equal(out[1].role, "tool");
  assert.equal(out[1].tool_call_id, "call_1");
  assert.equal(out[1].content, "r1");
});

test("normalizeOpenAIMessages fills synthetic result for missing tool_call", () => {
  const out = normalizeOpenAIMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "call_x", type: "function", function: { name: "f", arguments: "{}" } }] }
  ]);
  assert.equal(out[0].role, "assistant");
  assert.equal(out[1].role, "tool");
  assert.equal(out[1].tool_call_id, "call_x");
  assert.equal(out[1].content, "[Result omitted or operation cancelled]");
});

test("normalizeOpenAIMessages dedupes tool results already mounted", () => {
  const out = normalizeOpenAIMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "r1" },
    { role: "tool", tool_call_id: "call_1", content: "r1-dup" }
  ]);
  const toolMsgs = out.filter(m => m.role === "tool");
  assert.equal(toolMsgs.length, 1, "duplicate tool result must be dropped");
});

// ---- Anthropic -> OpenAI 请求转译 ----
test("transformAnthropicToOpenAI maps roles and content blocks", () => {
  const payload = transformAnthropicToOpenAI({
    model: "claude-sonnet",
    system: "you are helpful",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] }
    ]
  }, "deepseek-v4-flash");

  assert.equal(payload.model, "deepseek-v4-flash");
  assert.equal(payload.stream, true);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[0].content, "you are helpful");
  assert.equal(payload.messages[1].role, "user");
  assert.equal(payload.messages[1].content, "hi");
  assert.equal(payload.messages[2].role, "assistant");
  assert.equal(payload.messages[2].content, "hello");
});

test("transformAnthropicToOpenAI defaults model and preserves stream:false", () => {
  const payload = transformAnthropicToOpenAI({
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    stream: false
  });
  assert.equal(payload.model, "deepseek-v4.1-flash");
  assert.equal(payload.stream, false);
});

test("transformAnthropicToOpenAI attaches tools and passthrough params", () => {
  const payload = transformAnthropicToOpenAI({
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    tools: [{ name: "bash", description: "", input_schema: { type: "object", properties: {} } }],
    temperature: 0.7,
    max_tokens: 1024,
    top_p: 0.9
  }, "m");
  assert.ok(Array.isArray(payload.tools));
  assert.equal(payload.tool_choice, "auto");
  assert.equal(payload.temperature, 0.7);
  assert.equal(payload.max_tokens, 1024);
  assert.equal(payload.top_p, 0.9);
});

test("transformAnthropicToOpenAI handles tool_use and tool_result blocks", () => {
  const payload = transformAnthropicToOpenAI({
    messages: [
      { role: "user", content: [{ type: "text", text: "run ls" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file.txt" }] }
    ]
  }, "m");

  // assistant 消息应携带 tool_calls
  const assistant = payload.messages.find(m => m.role === "assistant");
  assert.ok(assistant, "assistant message present");
  assert.ok(Array.isArray(assistant.tool_calls));
  assert.equal(assistant.tool_calls[0].id, "tu_1");
  assert.equal(assistant.tool_calls[0].function.name, "bash");

  // tool_result 应作为 tool 消息挂接
  const toolMsg = payload.messages.find(m => m.role === "tool");
  assert.ok(toolMsg, "tool result present");
  assert.equal(toolMsg.tool_call_id, "tu_1");
});

// ---- OpenAI SSE -> Anthropic SSE 流式转译 ----
import { streamOpenAIToAnthropic } from "../src/exchange/exchange.js";

function openAISseResponse(lines) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l + "\n"));
      controller.close();
    }
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function readAnthropicEvents(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const b = block.trim();
    if (!b) continue;
    // 跳过保活 ping
    if (b.startsWith("event: ping")) continue;
    const lines = b.split("\n");
    const event = lines.find(l => l.startsWith("event: "))?.slice(7);
    const dataLine = lines.find(l => l.startsWith("data: "))?.slice(6);
    events.push({ event, data: dataLine ? JSON.parse(dataLine) : null });
  }
  return events;
}

test("streamOpenAIToAnthropic emits full Anthropic SSE lifecycle", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
    "data: [DONE]"
  ]);
  const resp = streamOpenAIToAnthropic(upstream, "claude-test");
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("Content-Type"), /text\/event-stream/);

  const events = await readAnthropicEvents(resp);
  const names = events.map(e => e.event);

  assert.equal(names[0], "message_start");
  assert.ok(names.includes("content_block_start"));
  assert.ok(names.includes("content_block_delta"));
  assert.ok(names.includes("content_block_stop"));
  assert.ok(names.includes("message_delta"));
  assert.equal(names[names.length - 1], "message_stop");

  // 文本内容应被拼合进 text_delta
  const deltas = events.filter(e => e.event === "content_block_delta");
  const text = deltas.map(d => d.data.delta.text).join("");
  assert.equal(text, "Hello world");

  // 最终 stop_reason 应为 end_turn（纯文本无工具调用）
  const msgDelta = events.find(e => e.event === "message_delta");
  assert.equal(msgDelta.data.delta.stop_reason, "end_turn");
});

test("streamOpenAIToAnthropic sets stop_reason=tool_use on tool_calls", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_9", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] }, finish_reason: "tool_calls" }] }),
    "data: [DONE]"
  ]);
  const resp = streamOpenAIToAnthropic(upstream, "m");
  const events = await readAnthropicEvents(resp);

  const blockStarts = events.filter(e => e.event === "content_block_start");
  const toolBlock = blockStarts.find(e => e.data.content_block.type === "tool_use");
  assert.ok(toolBlock, "tool_use block emitted");
  assert.equal(toolBlock.data.content_block.name, "bash");

  const msgDelta = events.find(e => e.event === "message_delta");
  assert.equal(msgDelta.data.delta.stop_reason, "tool_use");
});

test("streamOpenAIToAnthropic surfaces upstream business error as notice", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ code: 11128, message: "compliance filter" }),
    "data: [DONE]"
  ]);
  const resp = streamOpenAIToAnthropic(upstream, "m");
  const events = await readAnthropicEvents(resp);

  const deltas = events.filter(e => e.event === "content_block_delta");
  const text = deltas.map(d => d.data.delta.text).join("");
  assert.match(text, /compliance filter/);
});

// ---- 纯 reducer：单个 OpenAI chunk -> 发射指令 ----
import { reduceOpenAIChunk } from "../src/exchange/exchange.js";

test("reduceOpenAIChunk classifies text delta", () => {
  assert.deepEqual(reduceOpenAIChunk({ choices: [{ delta: { content: "hi" } }] }), { kind: "text", text: "hi" });
});

test("reduceOpenAIChunk classifies reasoning_content as thinking", () => {
  assert.deepEqual(reduceOpenAIChunk({ choices: [{ delta: { reasoning_content: "thinking..." } }] }), { kind: "thinking", text: "thinking..." });
});

test("reduceOpenAIChunk classifies tool_calls", () => {
  const out = reduceOpenAIChunk({ choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] } }] });
  assert.equal(out.kind, "tool_use");
  assert.equal(out.calls.length, 1);
  assert.equal(out.calls[0].id, "c1");
  assert.equal(out.calls[0].name, "bash");
  assert.equal(out.stopReason, "tool_use");
});

test("reduceOpenAIChunk classifies upstream business error", () => {
  const out = reduceOpenAIChunk({ code: 11128, message: "compliance filter" });
  assert.equal(out.kind, "error");
  assert.match(out.message, /compliance filter/);
});

test("reduceOpenAIChunk classifies error field", () => {
  const out = reduceOpenAIChunk({ error: { message: "boom" } });
  assert.equal(out.kind, "error");
  assert.equal(out.message, "boom");
});

test("reduceOpenAIChunk returns null for empty/invalid chunks", () => {
  assert.equal(reduceOpenAIChunk(null), null);
  assert.equal(reduceOpenAIChunk({}), null);
  assert.equal(reduceOpenAIChunk({ choices: [] }), null);
});

// ---- 共享纯 helper：错误消息 / 错误判定 / usage 提取 ----
import { extractErrorMessage, isUpstreamError, extractUsage } from "../src/exchange/exchange.js";

test("extractErrorMessage prefers error.message then msg then code", () => {
  assert.equal(extractErrorMessage({ error: { message: "boom" } }), "boom");
  assert.equal(extractErrorMessage({ msg: "m" }), "m");
  assert.equal(extractErrorMessage({ message: "msg" }), "msg");
  assert.equal(extractErrorMessage({ code: 11128 }), "Upstream error code 11128");
  assert.equal(extractErrorMessage({ code: 0 }), null);
  assert.equal(extractErrorMessage(null), null);
});

test("isUpstreamError detects error field and non-zero code", () => {
  assert.equal(isUpstreamError({ error: {} }), true);
  assert.equal(isUpstreamError({ code: 11128 }), true);
  assert.equal(isUpstreamError({ code: 0 }), false);
  assert.equal(isUpstreamError({}), false);
  assert.equal(isUpstreamError(null), false);
});

test("extractUsage extracts prompt/completion tokens, preserves fallback", () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 100, completion_tokens: 50 } }, { input: 0, output: 0 }), { input: 100, output: 50 });
  // 缺失字段保留当前值
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 100 } }, { input: 20, output: 1 }), { input: 100, output: 1 });
  // 无 usage 原样返回
  assert.deepEqual(extractUsage({}, { input: 20, output: 1 }), { input: 20, output: 1 });
});
