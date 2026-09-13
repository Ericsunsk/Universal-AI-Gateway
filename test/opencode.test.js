import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenCodeProvider,
  isFreeModel,
  DEFAULT_FREE_MODELS,
  parseProxyList,
  deriveSessionAndFingerprint,
  convertToolsToSystemPrompt,
  ModelHealthTracker,
  transformOpenAIMessagesToResponsesInput
} from "../src/providers/opencode/index.js";
import { createProvider } from "../src/providers/index.js";
import { dispatchExchange, transformAnthropicToOpenAI } from "../src/exchange/exchange.js";

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

test("createProvider throws on unknown provider type", () => {
  assert.throws(() => createProvider({ type: "nope" }, {}), /Unknown provider type "nope"/);
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
    assert.ok(capturedHeaders["User-Agent"].startsWith("opencode/1.18.30"), "User-Agent must start with opencode/1.18.30");
    assert.equal(capturedHeaders["x-opencode-version"], "1.18.30");
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

test("isFreeModel distinguishes free vs paid models accurately", () => {
  assert.equal(isFreeModel("mimo-v2.5-free"), true);
  assert.equal(isFreeModel("ling-3.0-flash-fin-free"), true);
  assert.equal(isFreeModel("muse-spark-1.3-contributor-free"), true);
  assert.equal(isFreeModel("big-pickle"), true);
  assert.equal(isFreeModel("nemotron-3-ultra-free"), true);
  assert.equal(isFreeModel("some-free-model"), true);

  assert.equal(isFreeModel("gpt-5.6-sol"), false);
  assert.equal(isFreeModel("claude-sonnet-5"), false);
  assert.equal(isFreeModel("muse-spark-1.3"), false);
  assert.equal(isFreeModel(""), false);
  assert.equal(isFreeModel(null), false);
});

test("OpenCodeProvider rejects paid models with 400 InvalidModelError", async () => {
  const provider = new OpenCodeProvider({}, {});
  const res = await provider.callChat({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.type, "InvalidModelError");
  assert.ok(data.error.message.includes("OpenCode Zen provider strictly supports free models only"));
});

test("fetchOfficialFreeModels pulls from upstream and filters out non-free models", async () => {
  const originalFetch = globalThis.fetch;
  let fetchedUrl = null;

  globalThis.fetch = async (url) => {
    fetchedUrl = url;
    return new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "claude-sonnet-5" },
        { id: "gpt-5.6-sol" },
        { id: "mimo-v2.5-free" },
        { id: "new-super-ai-free" }
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const provider = new OpenCodeProvider({}, {});
    const models = await provider.fetchOfficialFreeModels(true);

    assert.ok(fetchedUrl.endsWith("/models"));
    assert.ok(models.includes("new-super-ai-free"));
    assert.ok(models.includes("mimo-v2.5-free"));
    assert.ok(!models.includes("claude-sonnet-5"));
    assert.ok(!models.includes("gpt-5.6-sol"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchExchange returns 404 when model has no explicit route (issue #04)", async () => {
  const fakeFleet = {
    getProvider: (name) => {
      if (name === "opencode") {
        return new OpenCodeProvider({ type: "opencode" }, {});
      }
      return null;
    }
  };

  const originalFetch = globalThis.fetch;
  let capturedModel = null;

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    capturedModel = body.model;
    return new Response(JSON.stringify({
      id: "gen-789",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Dynamic discovery success!" } }]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    // 空路由配置，未显式声明 nemotron-3-ultra-free
    const emptyConfig = { routes: {} };

    const res = await dispatchExchange({
      request: new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }),
      body: { model: "nemotron-3-ultra-free", messages: [{ role: "user", content: "hi" }] },
      model: "nemotron-3-ultra-free",
      config: emptyConfig,
      fleet: fakeFleet,
      format: "openai"
    });

    // 新行为：未显式配置路由时返回 404
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error.message, "No route configured for model \"nemotron-3-ultra-free\". Available models: (none). To use this model, please add an explicit route in the configuration.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseProxyList parses comma, newline and semicolon separated proxies", () => {
  assert.deepEqual(parseProxyList("http://p1:8080, http://p2:8080"), ["http://p1:8080", "http://p2:8080"]);
  assert.deepEqual(parseProxyList("http://p1:8080\nhttp://p2:8080; http://p3:8080"), ["http://p1:8080", "http://p2:8080", "http://p3:8080"]);
  assert.deepEqual(parseProxyList(""), []);
  assert.deepEqual(parseProxyList(null), []);
});

test("deriveSessionAndFingerprint provides session affinity and authentic CLI headers", async () => {
  const payload1 = {
    messages: [
      { role: "user", content: "Write a fibonacci function in Rust" }
    ]
  };

  const payload2 = {
    messages: [
      { role: "user", content: "Write a fibonacci function in Rust" },
      { role: "assistant", content: "fn fib(n: u32) -> u32 { ... }" },
      { role: "user", content: "Now optimize it" }
    ]
  };

  const fp1 = await deriveSessionAndFingerprint(payload1, {});
  const fp2 = await deriveSessionAndFingerprint(payload2, {});

  // 相同对话首条用户消息生成稳定一致的 Session ID
  assert.equal(fp1.sessionId, fp2.sessionId);
  assert.equal(fp1.platform, fp2.platform);
  assert.equal(fp1.userAgent, fp2.userAgent);
  // 单次请求 ID 每次不同
  assert.notEqual(fp1.requestId, fp2.requestId);
  assert.ok(fp1.userAgent.startsWith("opencode/1.18.30 ("));
  assert.equal(fp1.version, "1.18.30");
});

test("OpenCodeProvider rotates proxy when encountering 429 rate limit", async () => {
  const originalFetch = globalThis.fetch;
  let fetchAttempts = 0;

  globalThis.fetch = async (url, options) => {
    fetchAttempts++;
    if (fetchAttempts === 1) {
      return new Response(JSON.stringify({
        error: { message: "FreeUsageLimitError: Rate limit exceeded" }
      }), { status: 429, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Success on proxy 2" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const provider = new OpenCodeProvider({
      config: {
        proxyUrls: "http://proxy1:8080, http://proxy2:8080"
      }
    }, {});

    assert.equal(provider.proxyList.length, 2);
    const res = await provider.callChat({
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "test" }]
    });

    assert.equal(res.status, 200);
    assert.equal(fetchAttempts, 2, "Must retry on next proxy");
    const json = await res.json();
    assert.equal(json.choices[0].message.content, "Success on proxy 2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callResponsesApi translates tools and function_call output correctly", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = null;

  globalThis.fetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      id: "resp_tools_test",
      output: [
        {
          type: "function_call",
          id: "call_abc123",
          name: "Bash",
          arguments: { command: "cargo test" }
        }
      ]
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const provider = new OpenCodeProvider({}, {});
    const res = await provider.callResponsesApi({
      model: "muse-spark-1.3",
      messages: [{ role: "user", content: "run test" }],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Run shell command",
            parameters: { type: "object", properties: { command: { type: "string" } } }
          }
        }
      ],
      tool_choice: "auto"
    });

    assert.equal(res.status, 200);
    assert.ok(capturedBody.tools, "Must pass tools to Responses API");
    assert.equal(capturedBody.tools[0].name, "Bash");
    const json = await res.json();
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    assert.equal(json.choices[0].message.tool_calls[0].function.name, "Bash");
    assert.equal(json.choices[0].message.tool_calls[0].function.arguments, '{"command":"cargo test"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelHealthTracker monitors latency, tracks cooldown, and prioritizes healthy models", () => {
  const tracker = new ModelHealthTracker();

  tracker.recordSuccess("mimo-v2.5-free", 200);
  tracker.recordSuccess("ling-3.0-flash-fin-free", 500);

  // 延迟更低的排在更前面
  let sorted = tracker.sortModels(["ling-3.0-flash-fin-free", "mimo-v2.5-free"]);
  assert.equal(sorted[0], "mimo-v2.5-free");

  // 模拟 mimo-v2.5-free 触发 429 频率限制
  tracker.recordFailure("mimo-v2.5-free", 429, true);
  assert.equal(tracker.isCooling("mimo-v2.5-free"), true);

  // 处于冷却状态的模型自动沉底，未冷却的优先
  sorted = tracker.sortModels(["mimo-v2.5-free", "ling-3.0-flash-fin-free"]);
  assert.equal(sorted[0], "ling-3.0-flash-fin-free");
  assert.equal(sorted[1], "mimo-v2.5-free");
});

test("transformAnthropicToOpenAI maps Claude Code thinking budget and model suffix to reasoning effort", () => {
  // 1. 通过模型后缀调节推理强度
  const payloadHigh = transformAnthropicToOpenAI({
    model: "muse-spark-1.3[high]",
    messages: [{ role: "user", content: "Solve hard math problem" }]
  }, "muse-spark-1.3-contributor-free");

  assert.equal(payloadHigh.reasoning_effort, "high");
  assert.deepEqual(payloadHigh.reasoning, { effort: "high", enabled: true });

  // 2. 通过 Claude Code thinking.budget_tokens 调节推理强度
  const payloadBudget = transformAnthropicToOpenAI({
    model: "muse-spark-1.3",
    messages: [{ role: "user", content: "Write quick test" }],
    thinking: { type: "enabled", budget_tokens: 1024 }
  }, "muse-spark-1.3-contributor-free");

  assert.equal(payloadBudget.reasoning_effort, "minimal");
  assert.deepEqual(payloadBudget.reasoning, { effort: "minimal", enabled: true });

  // 3. 通过 thinking.type: disabled 或 [off] 关闭思维链
  const payloadDisabled = transformAnthropicToOpenAI({
    model: "ling-3.0-flash[off]",
    messages: [{ role: "user", content: "hi" }]
  }, "ling-3.0-flash-fin-free");

  assert.deepEqual(payloadDisabled.reasoning, { enabled: false });
});

test("transformOpenAIMessagesToResponsesInput correctly transforms messages with tool calls and tool results", () => {
  const messages = [
    { role: "system", content: "You are an assistant." },
    { role: "user", content: "What is 2+2?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_calc_1",
          type: "function",
          function: { name: "calculator", arguments: '{"exp":"2+2"}' }
        }
      ]
    },
    {
      role: "tool",
      tool_call_id: "call_calc_1",
      content: "4"
    }
  ];

  const input = transformOpenAIMessagesToResponsesInput(messages);
  assert.equal(input.length, 4);
  assert.deepEqual(input[0], { role: "system", content: "You are an assistant." });
  assert.deepEqual(input[1], { role: "user", content: "What is 2+2?" });
  assert.deepEqual(input[2], {
    type: "function_call",
    call_id: "call_calc_1",
    name: "calculator",
    arguments: '{"exp":"2+2"}'
  });
  assert.deepEqual(input[3], {
    type: "function_call_output",
    call_id: "call_calc_1",
    output: "4"
  });
});






