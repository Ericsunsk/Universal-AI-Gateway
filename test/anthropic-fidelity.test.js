import test from "node:test";
import assert from "node:assert/strict";
import {
  mapAnthropicToolChoice,
  transformAnthropicToOpenAI,
  encodeAnthropicResponse
} from "../src/exchange/exchange.js";

function openAISseResponse(lines) {
  const text = lines.map(l => (l.endsWith("\n") ? l : l + "\n\n")).join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

async function readAnthropicEvents(response) {
  const text = await response.text();
  const rawEvents = text.split("\n\n").filter(Boolean);
  const events = [];
  for (const block of rawEvents) {
    const lines = block.split("\n");
    let eventName = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) eventName = line.slice(7).trim();
      if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
    }
    if (eventName && dataStr) {
      events.push({ event: eventName, data: JSON.parse(dataStr) });
    }
  }
  return events;
}

test("mapAnthropicToolChoice correctly translates all Anthropic tool_choice variants", () => {
  assert.equal(mapAnthropicToolChoice(), "auto");
  assert.equal(mapAnthropicToolChoice(null), "auto");
  assert.equal(mapAnthropicToolChoice({ type: "auto" }), "auto");
  assert.equal(mapAnthropicToolChoice({ type: "any" }), "required");
  assert.equal(mapAnthropicToolChoice({ type: "none" }), "none");
  assert.deepEqual(mapAnthropicToolChoice({ type: "tool", name: "calculator" }), {
    type: "function",
    function: { name: "calculator" }
  });
  assert.equal(mapAnthropicToolChoice("required"), "required");
});

test("transformAnthropicToOpenAI handles tool_choice, user_id and rejects document blocks", () => {
  // 1. tool_choice: { type: "any" } -> payload.tool_choice: "required"
  const payloadAny = transformAnthropicToOpenAI({
    messages: [{ role: "user", content: "calc" }],
    tools: [{ name: "calc", description: "", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "any" },
    metadata: { user_id: "user_42" }
  }, "m");
  assert.equal(payloadAny.tool_choice, "required");
  assert.equal(payloadAny.user, "user_42");

  // 2. tool_choice: { type: "tool", name: "calc" }
  const payloadTool = transformAnthropicToOpenAI({
    messages: [{ role: "user", content: "calc" }],
    tools: [{ name: "calc", description: "", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "tool", name: "calc" }
  }, "m");
  assert.deepEqual(payloadTool.tool_choice, {
    type: "function",
    function: { name: "calc" }
  });

  // 3. Document block (PDF) throws 400
  assert.throws(() => {
    transformAnthropicToOpenAI({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "see pdf" },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "xyz" } }
        ]
      }]
    }, "m");
  }, (err) => err.status === 400 && err.message.includes("document blocks (PDF)"));
});

test("encodeAnthropicResponse(stream:true) includes anthropic-version, initialInputTokens, and cache_read_input_tokens", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({
      choices: [{ delta: { content: "Cached response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 10 } }
    }),
    "data: [DONE]"
  ]);

  const resp = encodeAnthropicResponse({
    upstream, model: "m",
    initialInputTokens: 12, stream: true
  });

  assert.equal(resp.headers.get("anthropic-version"), "2023-06-01");
  const events = await readAnthropicEvents(resp);

  // message_start should immediately reflect initialInputTokens
  const startEvent = events.find(e => e.event === "message_start");
  assert.ok(startEvent);
  assert.equal(startEvent.data.message.usage.input_tokens, 12);

  // message_delta should expose reported input tokens and cache_read_input_tokens
  const deltaEvent = events.find(e => e.event === "message_delta");
  assert.ok(deltaEvent);
  assert.equal(deltaEvent.data.usage.input_tokens, 15);
  assert.equal(deltaEvent.data.usage.cache_read_input_tokens, 10);
});

test("encodeAnthropicResponse(stream:false) includes anthropic-version, tokens and cache_read_input_tokens", async () => {
  const upstream = openAISseResponse([
    "data: " + JSON.stringify({
      choices: [{ delta: { content: "Result" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 18 } }
    }),
    "data: [DONE]"
  ]);

  const resp = await encodeAnthropicResponse({ upstream, model: "m", stream: false });
  assert.equal(resp.headers.get("anthropic-version"), "2023-06-01");

  const json = await resp.json();
  assert.equal(json.usage.input_tokens, 20);
  assert.equal(json.usage.cache_read_input_tokens, 18);
});
