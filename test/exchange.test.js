import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformAnthropicToOpenAI,
  normalizeOpenAIMessages,
  transformToolsToOpenAI,
  finishReasonToAnthropic,
  dispatchExchange,
  pruneOpenAIMessages
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

// ---- H5 回归：非法 max_context_turns 不得静默裁掉历史 ----
test("transformAnthropicToOpenAI keeps full history on invalid max_context_turns", () => {
  const many = [];
  for (let i = 0; i < 80; i++) {
    many.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] });
  }
  // config 携带 NaN（模拟 KV 存量配置绕过 getDefaultConfig 的情形）
  const payload = transformAnthropicToOpenAI({ messages: many }, "m", { max_context_turns: NaN });
  // 80 轮全部保留 + 无 bridge 占位提示
  assert.equal(payload.messages.length, 80, "NaN must not prune history");
  assert.equal(payload.messages.some(m => typeof m.content === "string" && m.content.includes("omitted")), false);
});

test("transformAnthropicToOpenAI still prunes when max_context_turns is a valid number", () => {
  const many = [];
  for (let i = 0; i < 80; i++) {
    many.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] });
  }
  const payload = transformAnthropicToOpenAI({ messages: many }, "m", { max_context_turns: 10 });
  assert.ok(payload.messages.length < 80, "valid limit must prune");
  assert.ok(payload.messages.some(m => typeof m.content === "string" && m.content.includes("omitted")), "bridge notice present");
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

test("reduceOpenAIChunkAll returns [] for empty/invalid chunks, finish for delta-less stop", () => {
  assert.deepEqual(reduceOpenAIChunkAll(null), []);
  assert.deepEqual(reduceOpenAIChunkAll({}), []);
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [] }), []);
  // 无 delta 的终局 finish_reason 不再被丢弃（stop_reason 否则恒回退 end_turn）
  assert.deepEqual(reduceOpenAIChunkAll({ choices: [{ finish_reason: "stop" }] }), [{ kind: "finish", finishReason: "stop" }]);
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

test("transformAnthropicToOpenAI maps image blocks to OpenAI image_url parts", () => {
  const body = {
    model: "m",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        { type: "image", source: { type: "url", url: "https://example.com/x.png" } }
      ]
    }]
  };
  const out = transformAnthropicToOpenAI(body, "m", {});
  const m = out.messages[0];
  assert.equal(m.role, "user");
  assert.equal(m.content.length, 3, "text and both images keep original order");
  assert.deepEqual(m.content[0], { type: "text", text: "look at this" });
  assert.deepEqual(m.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } });
  assert.deepEqual(m.content[2], { type: "image_url", image_url: { url: "https://example.com/x.png" } });
});

test("transformAnthropicToOpenAI rejects invalid image sources with 400", () => {
  const cases = [
    { type: "image" },
    { type: "image", source: { type: "base64", data: "aGVsbG8=" } },
    { type: "image", source: { type: "base64", media_type: "image/png" } },
    { type: "image", source: { type: "file", data: "aGVsbG8=" } },
    { type: "image", source: { type: "url" } }
  ];
  for (const block of cases) {
    assert.throws(
      () => transformAnthropicToOpenAI({ model: "m", messages: [{ role: "user", content: [block] }] }, "m", {}),
      (err) => err.status === 400 && /image/i.test(err.message),
      `should reject ${JSON.stringify(block)}`
    );
  }
});

test("transformAnthropicToOpenAI keeps tool_result images out of tool text", () => {
  const bigImage = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" } };
  const body = {
    model: "m",
    messages: [
      { role: "user", content: "read the screenshot" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: ["file text", bigImage] }] }
    ]
  };
  const out = transformAnthropicToOpenAI(body, "m", {});
  const toolMsg = out.messages.find((msg) => msg.role === "tool");
  assert.ok(toolMsg, "tool message exists");
  assert.equal(toolMsg.content, "file text", "base64 never leaks into the tool token stream");
  assert.equal(toolMsg.content.includes("QUJDRA=="), false);

  const userMsgs = out.messages.filter((msg) => msg.role === "user");
  const imageMsg = userMsgs[userMsgs.length - 1];
  assert.ok(imageMsg, "trailing user message carries the image");
  assert.deepEqual(imageMsg.content, [
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJDRA==" } }
  ]);
});

test("transformAnthropicToOpenAI leaves image-free payloads untouched", () => {
  const body = {
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }]
  };
  const out = transformAnthropicToOpenAI(body, "m", {});
  assert.deepEqual(out.messages[0], { role: "user", content: "plain" });
});

test("dispatchExchange forwards image input to the upstream instead of rejecting it", async () => {
  let sentPayload = null;
  const fakeFleet = {
    getProvider: () => ({
      type: "openai",
      callChat: async (payload) => {
        sentPayload = payload;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    })
  };
  const res = await dispatchExchange({
    protocol: "anthropic",
    request: new Request("http://localhost/v1/messages", { method: "POST" }),
    body: {
      model: "m",
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]
      }]
    },
    model: "m",
    config: { routes: { m: [{ provider: "fake", model: "m" }] } },
    fleet: fakeFleet
  });
  assert.equal(res.status, 200);
  assert.ok(sentPayload, "image request reached the upstream");
  assert.deepEqual(sentPayload.messages[0].content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
  ]);
});

test("dispatchExchange surfaces upstream 400 for rejected image input (not 502)", async () => {
  // 能力探针：上游不支持视觉时回 400，客户端不能被包成 502
  const fakeFleet = {
    getProvider: () => ({
      type: "openai",
      callChat: async () => new Response(
        JSON.stringify({ error: { message: "image input is not supported by this model" } }),
        { status: 400 }
      )
    })
  };
  const res = await dispatchExchange({
    protocol: "anthropic",
    request: new Request("http://localhost/v1/messages", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }] }] },
    model: "m",
    config: { routes: { m: [{ provider: "fake", model: "m" }] } },
    fleet: fakeFleet
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.error.message.includes("image input is not supported"));
});

test("dispatchExchange redacts upstream endpoints and credentials from 4xx replies", async () => {
  // 上游响应体不可信：内部端点 / key / 内网 IP 不得随 4xx 回吐给客户端。
  const leaked = 'auth failed for key sk-ant-abcdef123456789 at https://internal.corp.local/v1 from 10.0.0.7';
  const fakeFleet = {
    getProvider: () => ({
      type: "openai",
      callChat: async () => new Response(JSON.stringify({ error: { message: leaked } }), { status: 400 })
    })
  };
  const res = await dispatchExchange({
    protocol: "anthropic",
    request: new Request("http://localhost/v1/messages", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "fake", model: "m" }] } },
    fleet: fakeFleet
  });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.ok(!error.message.includes("internal.corp.local"), "internal host must not leak");
  assert.ok(!error.message.includes("sk-ant-abcdef123456789"), "credential must not leak");
  assert.ok(!error.message.includes("10.0.0.7"), "internal IP must not leak");
  assert.ok(error.message.includes("<url>") && error.message.includes("<credential>"));
});

test("transformAnthropicToOpenAI rejects image blocks on assistant messages with 400", () => {
  // Anthropic 协议不允许 assistant 发图；OpenAI 方言也放不下。静默丢弃会让客户端以为图已送达。
  assert.throws(
    () => transformAnthropicToOpenAI({
      model: "m",
      messages: [{
        role: "assistant",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]
      }]
    }),
    (err) => err.status === 400 && /assistant messages/.test(err.message)
  );
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
  await new Promise(r => { setTimeout(r, 50); });
  assert.equal(upstreamCancelled, true, "upstream reader must be cancelled on abort");
  reader.releaseLock();
});

test("dispatchExchange fails over when upstream says model unavailable (different model next)", async () => {
  const calls = [];
  const fakeFleet = {
    getProvider: (name) => ({
      type: "openai",
      callChat: async (_payload) => {
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
  // 轮询间隔必须跟随 stallMs：写死 4s 会让本用例白等一个整拍（曾实测 4002ms）。
  // 收紧到 1s —— 既容忍 CI 抖动，又能守住这条例外不复发。
  assert.ok(elapsed < 1000, `stall polling must track stallMs, not a fixed 4s grid (took ${elapsed}ms)`);
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

test("stream translator logs upstream prefix-cache hits", async () => {
  // 经注入式 sink 观察日志，不再 monkey-patch console（曾污染子进程 stdout）。
  const lines = [];
  const { setLogSink } = await import("../src/logging/logger.js");
  const origDebug = process.env.DEBUG;
  process.env.DEBUG = "true"; // 启用调试日志以通过测试
  setLogSink((line) => { lines.push(line); });
  try {
    const upstream = openAISseResponse([
      "data: " + JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
      "data: " + JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } }),
      "data: [DONE]"
    ]);
    const resp = streamOpenAIToAnthropic(upstream, "m");
    await readAnthropicEvents(resp);
  } finally {
    setLogSink(null);
    if (origDebug !== undefined) process.env.DEBUG = origDebug;
    else delete process.env.DEBUG;
  }
  assert.ok(lines.some((l) => l.includes("prefix-cache hit") && l.includes("80")), "cache hit must be observable via logs");
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

test("streamOpenAIToAnthropic reports real output_tokens from upstream usage (L1)", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: { content: " world" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
    "data: [DONE]"
  ]);
  const events = await readAnthropicEvents(streamOpenAIToAnthropic(upstream, "m"));
  const msgDelta = events.find(e => e.event === "message_delta");
  assert.equal(msgDelta.data.usage.output_tokens, 7, "must use upstream completion_tokens, not hardcoded 60");
  assert.equal(msgDelta.data.usage.input_tokens, 12, "must report upstream prompt_tokens as input_tokens");
  assert.notEqual(msgDelta.data.usage.output_tokens, 60);
});

test("streamOpenAIToAnthropic estimates output_tokens when upstream omits usage (L1)", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({ choices: [{ delta: { content: "12345678" } }] }),
    "data: " + JSON.stringify({ choices: [{ delta: { content: "abcdefgh" } }] }),
    "data: [DONE]"
  ]);
  const events = await readAnthropicEvents(streamOpenAIToAnthropic(upstream, "m"));
  const msgDelta = events.find(e => e.event === "message_delta");
  // 16 字符 / 4 = 4，与 formatOpenAIToAnthropicJson 的估算口径一致
  assert.equal(msgDelta.data.usage.output_tokens, 4, "char-based estimate must replace the 60 placeholder");
  assert.notEqual(msgDelta.data.usage.output_tokens, 60);
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

test("dispatchExchange passes through unconfigured model to default provider without 404", async () => {
  let requestedPayload = null;
  const mockFleet = {
    getAllActive: () => [{ id: "mock_wb" }],
    getProvider: (id) => ({
      id,
      callChat: async (payload) => {
        requestedPayload = payload;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    })
  };

  const res = await dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    body: { model: "future-deepseek-r1-2026", messages: [{ role: "user", content: "hi" }] },
    model: "future-deepseek-r1-2026",
    config: { routes: {} },
    fleet: mockFleet,
    protocol: "openai"
  });

  assert.equal(res.status, 200);
  assert.equal(requestedPayload.model, "future-deepseek-r1-2026", "unconfigured model should passthrough directly to upstream");
});

// M3 接线集成回归：OpenAI 协议路径下，role:"tool" 的噪声输出必须经
// pruneOpenAIMessages 净化后才能到达上游（此前该路径完全不做优化）。
// 若 dispatch.js 的接线被移除，requestedPayload 将保留原始 ANSI/空行，本用例失败。
test("dispatchExchange OpenAI path prunes noisy role:tool output before upstream", async () => {
  let requestedPayload = null;
  const mockFleet = {
    getAllActive: () => [{ id: "mock_oai" }],
    getProvider: (id) => ({
      id,
      callChat: async (payload) => {
        requestedPayload = payload;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    })
  };

  const noisy = "\u001b[31m==========\u001b[0m\n\n\n\ndone";
  const res = await dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    body: {
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "c1", content: noisy }
      ]
    },
    model: "m",
    config: { routes: {} },
    fleet: mockFleet,
    protocol: "openai"
  });

  assert.equal(res.status, 200);
  // OpenAI 直传同样走 normalize：孤儿 tool 消息被包成 user [Tool Result:]，
  // 避免乱序直击上游触发 11148；prune 已先做 ANSI/换行清洗。
  const sentTool = requestedPayload.messages.find(m => String(m.content || "").includes("Tool Result"));
  assert.ok(sentTool, "tool result reaches upstream (normalized as user message)");
  assert.equal(sentTool.content.includes("\u001b"), false, "ANSI escapes stripped on OpenAI path");
  assert.equal(sentTool.content.includes("\n\n\n"), false, "excess newlines collapsed on OpenAI path");
  assert.ok(sentTool.content.includes("==========\n\ndone"));
});

test("dispatchExchange honors wildcard route routes['*'] when configured", async () => {
  let requestedPayload = null;
  const mockFleet = {
    getAllActive: () => [{ id: "wb" }],
    getProvider: (id) => ({
      id,
      callChat: async (payload) => {
        requestedPayload = payload;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    })
  };

  const res = await dispatchExchange({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }),
    body: { model: "any-custom-model", messages: [{ role: "user", content: "hi" }] },
    model: "any-custom-model",
    config: {
      routes: {
        "*": [{ provider: "wb" }]
      }
    },
    fleet: mockFleet,
    protocol: "openai"
  });

  assert.equal(res.status, 200);
  assert.equal(requestedPayload.model, "any-custom-model");
});


// ---- M3: OpenAI 协议路径工具输出优化（此前仅 Anthropic 路径生效）----
test("pruneOpenAIMessages cleans ANSI/separators on role:tool output", () => {
  const noisy = "\u001b[32mtest\u001b[0m\n" + "=".repeat(20) + "\n" + "a".repeat(30) + "\n\n\n\nb";
  const messages = [
    { role: "user", content: "run tests" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: noisy }
  ];
  const out = pruneOpenAIMessages(messages, false);
  const toolMsg = out.find(m => m.role === "tool");
  assert.ok(!toolMsg.content.includes("\u001b"), "ANSI should be stripped");
  assert.ok(!toolMsg.content.includes("=".repeat(6)), "separators collapsed");
  assert.ok(!toolMsg.content.includes("\n\n\n"), "excess newlines collapsed");
});

test("pruneOpenAIMessages preserves object identity when nothing changes", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "1", content: "clean output" }
  ];
  const out = pruneOpenAIMessages(messages, false);
  assert.equal(out, messages, "returns same array reference");
  assert.equal(out[1], messages[1], "same message object reference");
});

test("pruneOpenAIMessages returns non-array input unchanged", () => {
  assert.equal(pruneOpenAIMessages(null), null);
  assert.equal(pruneOpenAIMessages(undefined), undefined);
  assert.equal(pruneOpenAIMessages("x"), "x");
  const notArray = { role: "tool", content: "x" };
  assert.equal(pruneOpenAIMessages(notArray), notArray);
});

test("pruneOpenAIMessages reduces old huge tool output but keeps fresh one intact", () => {
  const huge = "L".repeat(5000);
  // 首轮（turnAge 大）与末轮（turnAge 小）各放一个巨大的 tool 结果
  const messages = [
    { role: "tool", tool_call_id: "old", content: huge },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "user", content: "u" },
    { role: "tool", tool_call_id: "fresh", content: huge }
  ];
  const out = pruneOpenAIMessages(messages, false);
  const oldMsg = out.find(m => m.tool_call_id === "old");
  const freshMsg = out.find(m => m.tool_call_id === "fresh");
  assert.ok(oldMsg.content.length < huge.length, "old huge output annealed");
  assert.ok(oldMsg.content.includes("collapsed"), "anneal notice present");
  assert.equal(freshMsg.content, huge, "fresh output stays full-fidelity");
});

// --- stream.js tool_call 分片合并（按 index 定址的唯一合并点）---

test("reduceOpenAIChunkAll preserves tool_call index for sparse fragments", async () => {
  const { reduceOpenAIChunkAll } = await import("../src/exchange/stream.js");
  const emissions = reduceOpenAIChunkAll({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: "x" } }] } }] });
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].calls[0].index, 1);
});

test("mergeSseToolFrags routes sparse fragments by index, not chunk position", async () => {
  const { mergeSseToolFrags } = await import("../src/exchange/stream.js");
  const frags = new Map();
  // 真实流式形态：每 chunk 只带一个 index 的碎片，calls 数组长度恒为 1
  mergeSseToolFrags(frags, [{ index: 0, name: "f", args: '{"a":' }]);
  mergeSseToolFrags(frags, [{ index: 1, name: "g", args: '{"b":' }]);
  assert.equal(frags.size, 2, "sparse fragments must not collapse into the first slot");
  assert.equal(frags.get("__idx_0").args, '{"a":');
  assert.equal(frags.get("__idx_1").args, '{"b":');
});

test("toolCallsToAnthropicBlocks parses args and preserves unparseable raw", async () => {
  const { toolCallsToAnthropicBlocks } = await import("../src/exchange/stream.js");
  const blocks = toolCallsToAnthropicBlocks([
    { id: "c1", name: "search", args: '{"q":"x"}' },
    { id: "c2", name: "broken", args: "{not json" },
    { id: "c3", name: null, args: "" },
  ]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: "tool_use", id: "c1", name: "search", input: { q: "x" } });
  // 不可解析的 arguments 不能被静默丢弃：保留原文供客户端归因
  assert.deepEqual(blocks[1].input, { _raw: "{not json" });
  assert.equal(blocks[2].name, "tool", "missing name falls back to 'tool'");
  assert.deepEqual(blocks[2].input, {});
});

test("toolCallsToAnthropicBlocks returns empty for empty input", async () => {
  const { toolCallsToAnthropicBlocks } = await import("../src/exchange/stream.js");
  assert.deepEqual(toolCallsToAnthropicBlocks([]), []);
  assert.deepEqual(toolCallsToAnthropicBlocks(null), []);
});

test("toolCallsToAnthropicBlocks generates an id when upstream omits it", async () => {
  const { toolCallsToAnthropicBlocks } = await import("../src/exchange/stream.js");
  const [b] = toolCallsToAnthropicBlocks([{ id: null, name: "f", args: "{}" }]);
  assert.ok(typeof b.id === "string" && b.id.startsWith("call_"), "must not emit id:null");
});

test("mergeSseToolFrags migrates placeholder key to real id when it arrives late", async () => {
  const { mergeSseToolFrags } = await import("../src/exchange/stream.js");
  const frags = new Map();
  // 首片无 id -> 建占位键
  mergeSseToolFrags(frags, [{ name: "search", args: '{"a":' }]);
  assert.equal(frags.size, 1);
  // 续片带 id -> 占位键应迁移到真实 id，而不是新建槽位
  mergeSseToolFrags(frags, [{ id: "call_x", args: "1}" }]);
  assert.equal(frags.size, 1, "late id must migrate the placeholder, not add a slot");
  const only = Array.from(frags.values())[0];
  assert.equal(only.id, "call_x");
  assert.equal(only.args, '{"a":1}');
});

test("mergeSseToolFrags keeps distinct ids in separate slots", async () => {
  const { mergeSseToolFrags } = await import("../src/exchange/stream.js");
  const frags = new Map();
  mergeSseToolFrags(frags, [{ id: "a", name: "f", args: "{" }]);
  mergeSseToolFrags(frags, [{ id: "b", name: "g", args: "{" }]);
  mergeSseToolFrags(frags, [{ id: "a", args: "}" }]);
  assert.equal(frags.size, 2);
  assert.equal(frags.get("a").args, "{}");
  assert.equal(frags.get("b").args, "{");
});

test("mergeSseToolFrags handles parallel calls where only some carry ids", async () => {
  const { mergeSseToolFrags } = await import("../src/exchange/stream.js");
  const frags = new Map();
  // 第 0 个带 id，第 1 个无 id（首片）
  mergeSseToolFrags(frags, [
    { id: "call_1", name: "f", args: "{" },
    { name: "g", args: "{" },
  ]);
  // 续片补上第 1 个的 id
  mergeSseToolFrags(frags, [
    { id: "call_1", args: "}" },
    { id: "call_2", args: "}" },
  ]);
  assert.equal(frags.size, 2, "two parallel calls must occupy exactly two slots");
  assert.equal(frags.get("call_1").args, "{}");
  assert.equal(frags.get("call_2").args, "{}");
  assert.equal(frags.get("call_1").ident, true);
  assert.equal(frags.get("call_2").ident, true);
});

test("mergeSseToolFrags leaves placeholder when upstream never sends an id", async () => {
  const { mergeSseToolFrags } = await import("../src/exchange/stream.js");
  const frags = new Map();
  mergeSseToolFrags(frags, [{ name: "f", args: "{" }]);
  mergeSseToolFrags(frags, [{ args: "}" }]);
  assert.equal(frags.size, 1);
  const only = Array.from(frags.values())[0];
  assert.equal(only.ident, false, "unidentified call stays a placeholder for the consumer");
  assert.equal(only.args, "{}");
});

// --- StreamBlockState：流式 content block 状态机（纯函数，不发 IO）---

test("StreamBlockState opens a block and closes the previous one", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  // 首个 block：无前置关闭
  const f1 = s.open("thinking");
  assert.equal(f1.length, 1);
  assert.ok(f1[0].includes("content_block_start"));
  assert.ok(f1[0].includes("\"index\":0"));
  // 切到 text：thinking 块收尾须补 signature_delta，
  // 再发 content_block_stop(index 0) 与 start(index 1)。
  const f2 = s.open("text");
  assert.equal(f2.length, 3, "thinking must emit signature_delta then stop, before opening next");
  assert.ok(f2[0].includes("signature_delta"), "thinking block needs a signature before closing");
  assert.ok(f2[1].includes("content_block_stop") && f2[1].includes("\"index\":0"));
  assert.ok(f2[2].includes("content_block_start") && f2[2].includes("\"index\":1"));
});

test("non-thinking block closes without a signature_delta frame", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  s.open("text");
  const frames = s.open("tool_use", { toolId: "t1", toolName: "f" });
  assert.ok(!JSON.stringify(frames).includes("signature_delta"), "text block must not emit a signature");
});

test("StreamBlockState deltas are suppressed when block type does not match", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  // 未开块：任何 delta 都不应产出帧（否则会发出 index:-1 的非法帧）
  assert.deepEqual(s.textDelta("x"), []);
  assert.deepEqual(s.thinkingDelta("x"), []);
  assert.deepEqual(s.inputJsonDelta("x"), []);
  s.open("text");
  assert.deepEqual(s.thinkingDelta("x"), [], "thinking delta into a text block must be dropped");
  assert.equal(s.textDelta("x").length, 1);
});

test("StreamBlockState counts emitted chars for text and thinking deltas", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  s.open("text");
  s.textDelta("hello");
  s.textDelta(" world");
  assert.equal(s.emittedChars, 11);
  // thinking 计入 output token 估算，与非流式 output_tokens 口径一致
  s.open("thinking");
  s.thinkingDelta("reasoning counted");
  assert.equal(s.emittedChars, 11 + "reasoning counted".length);
});

test("StreamBlockState setStopReason does not downgrade a set reason", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  assert.equal(s.stopReason, "end_turn", "default stop reason");
  s.setStopReason("tool_use");
  assert.equal(s.stopReason, "tool_use");
  // 后续 chunk 若再报 end_turn，不应把 tool_use 降级（否则客户端会误判无工具调用）
  s.setStopReason("end_turn");
  assert.equal(s.stopReason, "tool_use");
});

test("StreamBlockState close is idempotent and no-ops when nothing is open", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  assert.deepEqual(s.close(), [], "closing with no open block emits nothing");
  s.open("text");
  assert.equal(s.close().length, 1);
  assert.deepEqual(s.close(), [], "second close must not emit a duplicate stop");
});

test("StreamBlockState.applyEmission drives block transitions for each kind", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState();
  const joined = (frames) => frames.join("");

  const t = joined(s.applyEmission({ kind: "thinking", text: "think" }));
  assert.ok(t.includes("thinking_delta") && t.includes("\"index\":0"));

  const x = joined(s.applyEmission({ kind: "text", text: "hi" }));
  assert.ok(x.includes("content_block_stop") && x.includes("\"index\":0"));
  assert.ok(x.includes("text_delta") && x.includes("\"index\":1"));

  const u = joined(s.applyEmission({ kind: "tool_use", calls: [{ ident: true, id: "call_1", name: "search", args: "{\"q\":1}" }] }));
  assert.ok(u.includes("content_block_stop") && u.includes("\"index\":1"));
  assert.ok(u.includes("tool_use") && u.includes("call_1") && u.includes("search"));
  assert.ok(u.includes("input_json_delta"));
  assert.equal(s.stopReason, "tool_use");

  // finish 仅设置 stop_reason，不产出帧
  assert.deepEqual(s.applyEmission({ kind: "finish", finishReason: "stop" }), []);
  // 未知 kind 安全忽略
  assert.deepEqual(s.applyEmission({ kind: "unknown" }), []);
  assert.deepEqual(s.applyEmission(null), []);
});

// --- stop_sequences 透传与 stop_reason 判定 ---

test("stop_sequences is translated to upstream stop", async () => {
  const { transformAnthropicToOpenAI } = await import("../src/exchange/exchange.js");
  const payload = transformAnthropicToOpenAI({
    model: "m",
    stop_sequences: ["</done>", "STOP"],
    messages: [{ role: "user", content: "hi" }]
  });
  assert.deepEqual(payload.stop, ["</done>", "STOP"]);
});

test("absent stop_sequences leaves no stop field upstream", async () => {
  const { transformAnthropicToOpenAI } = await import("../src/exchange/exchange.js");
  const payload = transformAnthropicToOpenAI({
    model: "m",
    messages: [{ role: "user", content: "hi" }]
  });
  assert.ok(!("stop" in payload), "no stop key when client sent no sequences");
});

test("finishReasonToAnthropic reports stop_sequence only on a confirmed tail hit", async () => {
  const { finishReasonToAnthropic } = await import("../src/exchange/stream.js");
  // 未下发序列：即使上游回 stop 也只报 end_turn
  assert.equal(finishReasonToAnthropic("stop", { hasStopSequences: false, text: "abc</done>" }), "end_turn");
  // 下发且尾部命中：报 stop_sequence
  assert.equal(
    finishReasonToAnthropic("stop", { hasStopSequences: true, text: "abc</done>", stopSequences: ["</done>"] }),
    "stop_sequence"
  );
  // 下发但尾部未命中（自然停止）：退回 end_turn，不误报
  assert.equal(
    finishReasonToAnthropic("stop", { hasStopSequences: true, text: "just a normal end", stopSequences: ["</done>"] }),
    "end_turn"
  );
  // 既有语义零回归
  assert.equal(finishReasonToAnthropic("length"), "max_tokens");
  assert.equal(finishReasonToAnthropic("tool_calls"), "tool_use");
  assert.equal(finishReasonToAnthropic("content_filter"), "end_turn");
  assert.equal(finishReasonToAnthropic(null), "end_turn");
});

// --- 停止序列：窗口长度与归一化（code review 修复）---

test("stop sequence longer than 64 chars is still detected", async () => {
  const { finishReasonToAnthropic } = await import("../src/exchange/stream.js");
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  // 100 字符的哨兵：旧实现写死 64 字符尾部窗口，此类序列恒失配。
  const longSeq = "S".repeat(100);
  const s = new StreamBlockState([longSeq]);
  s.open("text");
  s.textDelta("prefix ");
  s.textDelta(longSeq);
  assert.ok(s.textTail.includes(longSeq), "tail window must be sized to the longest stop sequence");
  assert.equal(
    finishReasonToAnthropic("stop", { hasStopSequences: true, text: s.textTail, stopSequences: [longSeq] }),
    "stop_sequence"
  );
});

test("no tail accumulation when the request carried no stop sequences", async () => {
  const { StreamBlockState } = await import("../src/exchange/stream.js");
  const s = new StreamBlockState([]);
  s.open("text");
  s.textDelta("some long output that would otherwise be buffered");
  assert.equal(s.textTail, "", "hot path must not allocate a tail window when unused");
});

test("normalizeStopSequences filters blank entries and caps at 4", async () => {
  const { normalizeStopSequences } = await import("../src/exchange/exchange.js");
  assert.deepEqual(normalizeStopSequences(["a", "", "   ", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeStopSequences(["1", "2", "3", "4", "5", "6"]), ["1", "2", "3", "4"]);
  assert.deepEqual(normalizeStopSequences(["  "]), []);
  assert.deepEqual(normalizeStopSequences(undefined), []);
  assert.deepEqual(normalizeStopSequences("not an array"), []);
});

test("blank-only stop_sequences produce no upstream stop field", async () => {
  const { transformAnthropicToOpenAI } = await import("../src/exchange/exchange.js");
  const payload = transformAnthropicToOpenAI({
    model: "m",
    stop_sequences: ["", "  "],
    messages: [{ role: "user", content: "hi" }]
  });
  assert.ok(!("stop" in payload), "empty stop strings must not reach upstream (400 risk)");
});

test("resolveStopDetails handles upstream stop_sequence finish_reason", async () => {
  const { resolveStopDetails, finishReasonToAnthropic } = await import("../src/exchange/stream.js");
  const res1 = resolveStopDetails("stop_sequence", {
    hasStopSequences: true,
    text: "result </done>",
    stopSequences: ["</done>"]
  });
  assert.deepEqual(res1, { stopReason: "stop_sequence", stopSequence: "</done>" });
  assert.equal(finishReasonToAnthropic("stop_sequence"), "stop_sequence");

  // When upstream stripped stop sequence from text but reported stop_sequence
  const res2 = resolveStopDetails("stop_sequence", {
    hasStopSequences: true,
    text: "result without trailing token",
    stopSequences: ["</done>"]
  });
  assert.deepEqual(res2, { stopReason: "stop_sequence", stopSequence: "</done>" });
});

test("resolveStopDetails returns consistent stopReason and stopSequence across all reasons", async () => {
  const { resolveStopDetails } = await import("../src/exchange/stream.js");
  assert.deepEqual(resolveStopDetails("length"), { stopReason: "max_tokens", stopSequence: null });
  assert.deepEqual(resolveStopDetails("tool_calls"), { stopReason: "tool_use", stopSequence: null });
  assert.deepEqual(resolveStopDetails("tool_use"), { stopReason: "tool_use", stopSequence: null });
  assert.deepEqual(resolveStopDetails("content_filter"), { stopReason: "end_turn", stopSequence: null });
  assert.deepEqual(resolveStopDetails(null), { stopReason: "end_turn", stopSequence: null });
});

test("formatOpenAIToAnthropicJson includes signature on thinking blocks", async () => {
  const { formatOpenAIToAnthropicJson } = await import("../src/exchange/exchange.js");
  const sseBody = [
    "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking step\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n"
  ].join("");
  const resp = await formatOpenAIToAnthropicJson(new Response(sseBody), "m");
  assert.equal(resp.status, 200);
  const json = await resp.json();
  const thinkingBlock = json.content.find(b => b.type === "thinking");
  assert.ok(thinkingBlock, "thinking block must be present");
  assert.equal(thinkingBlock.thinking, "thinking step");
  assert.equal(thinkingBlock.signature, "sig_synthetic_done", "thinking block must carry signature for Anthropic protocol compliance");
});
