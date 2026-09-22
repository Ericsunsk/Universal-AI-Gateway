import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformAnthropicToOpenAI,
  normalizeOpenAIMessages,
  transformToolsToOpenAI,
  finishReasonToAnthropic,
  dispatchExchange
} from "../src/exchange/exchange.js";
import { parseReasoningIntent } from "../src/exchange/reasoning.js";

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
import { reduceOpenAIChunkAll } from "../src/exchange/exchange.js";

test("reduceOpenAIChunkAll classifies text delta", () => {
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [{ delta: { content: "hi" } }] }), [{ kind: "text", text: "hi" }]);
});

test("reduceOpenAIChunkAll classifies reasoning_content as thinking", () => {
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [{ delta: { reasoning_content: "thinking..." } }] }), [{ kind: "thinking", text: "thinking..." }]);
});

test("reduceOpenAIChunkAll classifies tool_calls", () => {
  const out = reduceOpenAIChunkAll({ choices: [{ delta: { tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }] } }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "tool_use");
  assert.equal(out[0].calls.length, 1);
  assert.equal(out[0].calls[0].id, "c1");
  assert.equal(out[0].calls[0].name, "bash");
  assert.equal(out[0].stopReason, "tool_use");
});

test("reduceOpenAIChunkAll classifies upstream business error", () => {
  const out = reduceOpenAIChunkAll({ code: 11128, message: "compliance filter" });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "error");
  assert.match(out[0].message, /compliance filter/);
});

test("reduceOpenAIChunkAll classifies error field", () => {
  const out = reduceOpenAIChunkAll({ error: { message: "boom" } });
  assert.deepEqual(out, [{ kind: "error", message: "boom" }]);
});

test("reduceOpenAIChunkAll returns [] for empty/invalid/delta-less chunks", () => {
  assert.deepEqual(reduceOpenAIChunkAll(null), []);
  assert.deepEqual(reduceOpenAIChunkAll({}), []);
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [] }), []);
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [{ finish_reason: "stop" }] }), []);
});

test("reduceOpenAIChunkAll emits thinking+text+tool+finish in order for mixed chunk", () => {
  const out = reduceOpenAIChunkAll({ choices: [{ delta: {
    reasoning_content: "r", content: "c",
    tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }]
  }, finish_reason: "tool_calls" }] });
  assert.deepEqual(out.map(e => e.kind), ["thinking", "text", "tool_use", "finish"]);
  assert.equal(out[3].finishReason, "tool_calls");
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
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 100 } }, { input: 20, output: 1 }), { input: 100, output: 1 });
  assert.deepEqual(extractUsage({}, { input: 20, output: 1 }), { input: 20, output: 1 });
});

test("dispatchExchange preserves upstream error without body consumption crash", async () => {
  const fakeFleet = {
    getProvider: (name) => {
      if (name === "fake") {
        return {
          type: "workbuddy",
          callChat: async () => {
            return new Response(JSON.stringify({ error: { code: 14018, msg: "额度已用尽" } }), {
              status: 429,
              headers: { "Content-Type": "application/json" }
            });
          }
        };
      }
      return null;
    }
  };

  const fakeConfig = {
    routes: {
      "test-model": [{ provider: "fake", model: "test-model" }]
    }
  };

  const res = await dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    body: { model: "test-model", messages: [{ role: "user", content: "hi" }] },
    model: "test-model",
    config: fakeConfig,
    fleet: fakeFleet,
    format: "openai"
  });

  assert.equal(res.status, 429);
  const text = await res.text();
  assert.ok(text.includes("额度已用尽"));
});

test("finishReasonToAnthropic maps OpenAI reasons correctly", () => {
  assert.equal(finishReasonToAnthropic("length"), "max_tokens");
  assert.equal(finishReasonToAnthropic("tool_calls"), "tool_use");
  assert.equal(finishReasonToAnthropic("function_call"), "tool_use");
  assert.equal(finishReasonToAnthropic("content_filter"), "end_turn");
  assert.equal(finishReasonToAnthropic("stop"), "end_turn");
  assert.equal(finishReasonToAnthropic(null), "end_turn");
});

test("transformAnthropicToOpenAI accepts a pre-parsed intent (parse once)", () => {
  const body = {
    model: "deepseek-v4-flash[high]",
    messages: [{ role: "user", content: "hi" }]
  };
  const intent = parseReasoningIntent({ model: body.model, body });
  const withIntent = transformAnthropicToOpenAI(body, "m", {}, intent);
  const withoutIntent = transformAnthropicToOpenAI(body, "m", {});
  assert.deepEqual(withIntent, withoutIntent);
  assert.equal(withIntent.reasoning_effort, "high");
});

test("transformAnthropicToOpenAI rejects image blocks with 400", () => {
  const body = {
    model: "m",
    messages: [{ role: "user", content: [{ type: "image", source: {} }] }]
  };
  try {
    transformAnthropicToOpenAI(body, "m", {});
    assert.fail("should throw for image blocks");
  } catch (err) {
    assert.equal(err.status, 400);
    assert.ok(err.message.includes("Image content blocks"));
  }
});

test("transformAnthropicToOpenAI validates system array with 400", () => {
  assert.throws(
    () => transformAnthropicToOpenAI({ model: "m", system: [{ text: 123 }], messages: [] }, "m", {}),
    (err) => err.status === 400 && err.message.includes("system[0].text")
  );
});

test("streamOpenAIToAnthropic cancels upstream on client abort (no stranded pump)", async () => {
  let upstreamCancelled = false;
  const slowUpstream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
      // 然后停顿：不断流、不结束，模拟用户中途点“停止生成”
    },
    cancel() { upstreamCancelled = true; }
  });
  const upstream = new Response(slowUpstream, { status: 200 });
  const ac = new AbortController();
  const res = streamOpenAIToAnthropic(upstream, "m", ac.signal);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false, "first block must arrive before abort");
  ac.abort();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(upstreamCancelled, true, "upstream reader must be cancelled on abort");
  reader.releaseLock();
});

test("dispatchExchange returns 400 (not 502) for image input", async () => {
  const fakeFleet = { getProvider: () => ({ type: "openai", callChat: async () => { throw new Error("must not reach upstream"); } }) };
  const res = await dispatchExchange({
    protocol: "anthropic",
    request: new Request("http://localhost/v1/messages", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: [{ type: "image" }] }] },
    model: "m",
    config: { routes: { m: [{ provider: "fake", model: "m" }] } },
    fleet: fakeFleet
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.error.message.includes("Image content blocks"));
});

test("dispatchExchange fails over when upstream says model unavailable (different model next)", async () => {
  const calls = [];
  const fakeFleet = {
    getProvider: (name) => ({
      type: "openai",
      callChat: async (payload) => {
        calls.push(name);
        if (name === "first") {
          return new Response(JSON.stringify({ error: { message: "Model is unavailable" } }), { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "backup ok" } }] }), { status: 200 });
      }
    })
  };
  const res = await dispatchExchange({
    protocol: "openai",
    request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "first", model: "gone-model" }, { provider: "second", model: "backup-model" }] } },
    fleet: fakeFleet
  });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["first", "second"]);
  const json = await res.json();
  assert.equal(json.choices[0].message.content, "backup ok");
});

test("dispatchExchange does not fail over model errors onto the same model", async () => {
  const calls = [];
  const fakeFleet = {
    getProvider: (name) => ({
      type: "openai",
      callChat: async () => {
        calls.push(name);
        return new Response(JSON.stringify({ error: { message: "Model is unavailable" } }), { status: 400 });
      }
    })
  };
  const res = await dispatchExchange({
    protocol: "openai",
    request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "first", model: "same-model" }, { provider: "second", model: "same-model" }] } },
    fleet: fakeFleet
  });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, ["first"], "same model next → fail fast, no pointless retry");
});

test("streamOpenAIToAnthropic closes stalled upstream instead of hanging", async () => {
  // 上游 200 但正文永远不来字节：必须熔断收尾，不能无限 ping
  const hung = new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
  const started = Date.now();
  const resp = streamOpenAIToAnthropic(hung, "m", null, {}, { stallMs: 50 });
  const events = await readAnthropicEvents(resp);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `stall guard must fire promptly (took ${elapsed}ms)`);
  assert.equal(events[0].event, "message_start");
  assert.equal(events[events.length - 1].event, "message_stop");
  const text = events
    .filter(e => e.event === "content_block_delta")
    .map(d => d.data.delta.text || "")
    .join("");
  assert.match(text, /stalled/);
});

test("transformAnthropicToOpenAI is byte-stable for identical input (prefix-cache invariant)", () => {
  const body = {
    model: "m",
    system: [
      { type: "text", text: "You are a coder.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Be concise." }
    ],
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "again" }] }
    ]
  };
  const once = JSON.stringify(transformAnthropicToOpenAI(body, "m", {}, null));
  const twice = JSON.stringify(transformAnthropicToOpenAI(body, "m", {}, null));
  assert.equal(once, twice, "same conversation must serialize to identical bytes or upstream prefix cache breaks");
});

test("transformAnthropicToOpenAI folds system blocks for OpenAI-shaped upstreams (no cache_control forwarding)", () => {
  // OpenAI 形上游不认 cache_control，透传反而可能 400；原生 Anthropic 路径走 dispatch 直传不经过这里。
  const out = transformAnthropicToOpenAI({
    model: "m",
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }]
  }, "m", {}, null);
  assert.deepEqual(out.messages[0], { role: "system", content: "sys" });
});

test("extractCachedTokens reads OpenAI and Anthropic cache fields", async () => {
  const { extractCachedTokens } = await import("../src/exchange/exchange.js");
  assert.equal(extractCachedTokens({ usage: { prompt_tokens_details: { cached_tokens: 80 } } }), 80);
  assert.equal(extractCachedTokens({ usage: { cache_read_input_tokens: 120 } }), 120);
  assert.equal(extractCachedTokens({ usage: { prompt_tokens: 10 } }), 0);
  assert.equal(extractCachedTokens({}), 0);
  assert.equal(extractCachedTokens(null), 0);
});

test("stream translator records upstream prefix-cache hits", async () => {
  const { snapshotCacheStats, resetCacheStats } = await import("../src/core/cacheStats.js");
  resetCacheStats();
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } }),
    "data: [DONE]"
  ]);
  const resp = streamOpenAIToAnthropic(upstream, "m");
  await readAnthropicEvents(resp);
  const snap = snapshotCacheStats();
  assert.equal(snap.responses, 1);
  assert.equal(snap.cachedResponses, 1);
  assert.equal(snap.cachedTokens, 80);
  assert.equal(snap.hitRate, 100);
  resetCacheStats();
});

test("streamOpenAIToAnthropic emits both thinking and text from one mixed chunk", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "r1", content: "c1" } }] }),
    "data: [DONE]"
  ]);
  const resp = streamOpenAIToAnthropic(upstream, "m");
  const events = await readAnthropicEvents(resp);
  const starts = events.filter(e => e.event === "content_block_start").map(e => e.data.content_block.type);
  assert.deepEqual(starts, ["thinking", "text"]);
});

test("formatOpenAIToAnthropicJson accumulates SSE tool_calls into tool_use blocks", async () => {
  const { formatOpenAIToAnthropicJson } = await import("../src/exchange/exchange.js");
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{\"cm" } }] } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: "d\":\"ls\"}" } }] } }] }),
    "data: [DONE]"
  ]);
  const resp = await formatOpenAIToAnthropicJson(upstream, "m");
  const body = await resp.json();
  const tool = body.content.find(c => c.type === "tool_use");
  assert.ok(tool, "SSE tool_calls must surface as tool_use (was silently dropped)");
  assert.equal(tool.id, "call_1");
  assert.deepEqual(tool.input, { cmd: "ls" }, "fragments merge by id before parse");
  assert.equal(body.stop_reason, "end_turn");
});

test("formatOpenAIToAnthropicJson maps SSE finish_reason to stop_reason", async () => {
  const { formatOpenAIToAnthropicJson } = await import("../src/exchange/exchange.js");
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "length" }] }),
    "data: [DONE]"
  ]);
  const resp = await formatOpenAIToAnthropicJson(upstream, "m");
  const body = await resp.json();
  assert.equal(body.stop_reason, "max_tokens", "SSE finish was previously ignored (always end_turn)");
});
