import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeProvider } from "../src/providers/opencode.js";
import { createProvider } from "../src/providers/index.js";
import { dispatchExchange } from "../src/exchange/exchange.js";

test("OpenCodeProvider initializes with correct defaults", () => {
  const provider = new OpenCodeProvider({}, {});
  assert.equal(provider.id, "opencode");
  assert.equal(provider.type, "opencode");
  assert.equal(provider.baseUrl, "https://opencode.ai/zen/v1");
});

test("OpenCodeProvider getBalance reports unlimited free tier", async () => {
  const provider = new OpenCodeProvider({}, {});
  const bal = await provider.getBalance();
  assert.equal(bal.success, true);
  assert.ok(bal.balance.includes("Free Tier"));
});

test("createProvider factory supports opencode type", () => {
  const provider = createProvider({ type: "opencode" }, {});
  assert.ok(provider instanceof OpenCodeProvider);
});

test("OpenCodeProvider injects required session headers on callChat", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders = null;
  let capturedBody = null;

  globalThis.fetch = async (url, options) => {
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "pong" } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const provider = new OpenCodeProvider({}, {});
    const res = await provider.callChat({
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "ping" }]
    });

    assert.equal(res.status, 200);
    assert.ok(capturedHeaders["x-opencode-session"], "Must contain x-opencode-session");
    assert.ok(capturedHeaders["x-opencode-request"], "Must contain x-opencode-request");
    assert.equal(capturedHeaders["x-opencode-client"], "cli");
    assert.equal(capturedHeaders["User-Agent"], "opencode/1.18.30");
    assert.equal(capturedBody.model, "mimo-v2.5-free");
    assert.equal(res.headers.get("x-gateway-account"), "opencode-zen");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchExchange seamlessly routes and falls back to opencode", async () => {
  const fakeFleet = {
    getProvider: (name) => {
      if (name === "workbuddy") {
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
      if (name === "opencode") {
        return new OpenCodeProvider({
          type: "opencode"
        }, {});
      }
      return null;
    }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return new Response(JSON.stringify({
      id: "gen-123",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Fallback success!" } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-gateway-account": "opencode-zen" }
    });
  };

  try {
    const fakeConfig = {
      routes: {
        "deepseek-v4.1-flash": [
          { provider: "workbuddy", model: "deepseek-v4.1-flash" },
          { provider: "opencode", model: "mimo-v2.5-free" }
        ]
      }
    };

    const res = await dispatchExchange({
      request: new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }),
      body: { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] },
      model: "deepseek-v4.1-flash",
      config: fakeConfig,
      fleet: fakeFleet,
      format: "openai"
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-gateway-fallback"), "true");
    assert.equal(res.headers.get("x-gateway-model"), "mimo-v2.5-free");
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "Fallback success!");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reduceOpenAIChunk supports OpenCode delta.reasoning", async () => {
  const { reduceOpenAIChunk } = await import("../src/exchange/exchange.js");
  const result = reduceOpenAIChunk({
    choices: [{ delta: { reasoning: "Thinking through the solution step by step..." } }]
  });
  assert.deepEqual(result, {
    kind: "thinking",
    text: "Thinking through the solution step by step..."
  });
});

test("streamOpenAIToAnthropic streams thinking blocks from delta.reasoning", async () => {
  const { streamOpenAIToAnthropic } = await import("../src/exchange/exchange.js");

  const streamBody = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Let me ponder..." } }] })}\n\n`));
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Here is the answer." } }] })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });

  const resp = streamOpenAIToAnthropic(
    new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } }),
    "claude-3-7-sonnet-20250219"
  );

  const text = await resp.text();
  assert.ok(text.includes('"type":"thinking"'), "Must include thinking block start");
  assert.ok(text.includes('"type":"thinking_delta"'), "Must include thinking delta");
  assert.ok(text.includes("Let me ponder..."), "Must include reasoning content");
  assert.ok(text.includes('"type":"text_delta"'), "Must include text delta");
  assert.ok(text.includes("Here is the answer."), "Must include answer content");
});

test("dispatchExchange cascades through OpenCode models when FreeUsageLimitError occurs", async () => {
  const fakeFleet = {
    getProvider: (name) => {
      if (name === "opencode") {
        return new OpenCodeProvider({ type: "opencode" }, {});
      }
      return null;
    }
  };

  const originalFetch = globalThis.fetch;
  const attemptedModels = [];

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    attemptedModels.push(body.model);

    if (body.model === "mimo-v2.5-free") {
      // 模拟 mimo-v2.5-free 触发 IP 频率限制
      return new Response(JSON.stringify({
        error: { message: "FreeUsageLimitError: Rate limit exceeded" }
      }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (body.model === "ling-3.0-flash-fin-free") {
      // 级联到下一个模型并成功响应
      return new Response(JSON.stringify({
        id: "gen-456",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Cascaded success from ling!" } }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-gateway-account": "opencode-zen" }
      });
    }

    return new Response("Not found", { status: 404 });
  };

  try {
    const fakeConfig = {
      routes: {
        "mimo-v2.5-free": [
          { provider: "opencode", model: "mimo-v2.5-free" },
          { provider: "opencode", model: "ling-3.0-flash-fin-free" },
          { provider: "opencode", model: "big-pickle" }
        ]
      }
    };

    const res = await dispatchExchange({
      request: new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }),
      body: { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] },
      model: "mimo-v2.5-free",
      config: fakeConfig,
      fleet: fakeFleet,
      format: "openai"
    });

    assert.equal(res.status, 200);
    assert.deepEqual(attemptedModels, ["mimo-v2.5-free", "ling-3.0-flash-fin-free"]);
    assert.equal(res.headers.get("x-gateway-fallback"), "true");
    assert.equal(res.headers.get("x-gateway-model"), "ling-3.0-flash-fin-free");
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "Cascaded success from ling!");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCodeProvider routes muse-spark models to /zen/v1/responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = null;
  let capturedBody = null;

  globalThis.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: "resp_123",
      object: "response",
      created_at: 1789280000,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Sparkling hello!" }]
        }
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const provider = new OpenCodeProvider({}, {});
    const res = await provider.callChat({
      model: "muse-spark-1.3",
      messages: [{ role: "user", content: "hi" }],
      stream: false
    });

    assert.equal(res.status, 200);
    assert.ok(capturedUrl.endsWith("/responses"), "Must call /responses endpoint");
    assert.equal(capturedBody.model, "muse-spark-1.3-contributor-free", "Must normalize to free tier variant");
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "Sparkling hello!");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


