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
