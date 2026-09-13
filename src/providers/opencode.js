import { buildResponseHeaders } from "../http/headers.js";

export const DEFAULT_FREE_MODELS = [
  "mimo-v2.5-free",
  "ling-3.0-flash-fin-free",
  "big-pickle",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-flash-free"
];

export function isFreeModel(id) {
  if (!id || typeof id !== "string") return false;
  const lower = id.toLowerCase().trim();
  return (
    lower.endsWith("-free") ||
    lower.includes("-contributor-free") ||
    lower.includes("-free-") ||
    lower === "big-pickle"
  );
}

export function parseProxyList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw)
    .split(/[,;\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

export const PLATFORMS = [
  "darwin; arm64",
  "darwin; x64",
  "linux; x64",
  "windows; x64"
];

/**
 * 计算会话亲和性标识与真实的 OpenCode CLI 指纹
 * 在连续对话或多轮调用中复用同一个 Session ID，极大提升防风控能力
 */
export async function deriveSessionAndFingerprint(payload, options = {}) {
  let sessionId = options.sessionId;
  if (!sessionId && options.request?.headers) {
    const getH = (k) => typeof options.request.headers.get === "function" ? options.request.headers.get(k) : options.request.headers[k];
    sessionId = getH("x-session-id") || getH("x-conversation-id") || getH("session-id");
  }

  if (!sessionId) {
    const firstUserMsg = payload?.messages?.find(m => m.role === "user");
    const seed = firstUserMsg
      ? (typeof firstUserMsg.content === "string" ? firstUserMsg.content : JSON.stringify(firstUserMsg.content))
      : "";

    if (seed && seed.length > 3) {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(seed);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
        sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      } catch (e) {
        sessionId = crypto.randomUUID();
      }
    } else {
      sessionId = crypto.randomUUID();
    }
  }

  let charSum = 0;
  for (let i = 0; i < sessionId.length; i++) {
    charSum += sessionId.charCodeAt(i);
  }
  const platform = PLATFORMS[charSum % PLATFORMS.length];

  return {
    sessionId,
    requestId: crypto.randomUUID(),
    platform,
    userAgent: `opencode/1.18.30 (${platform})`,
    version: "1.18.30"
  };
}

/**
 * 工具调用提示词降级适配器（Polyfill）
 * 当上游免费模型不支持原生 OpenAI JSON Tools 时，自动将工具注入 System Prompt
 */
export function convertToolsToSystemPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  let prompt = "\n\n[AVAILABLE TOOLS]\nYou have access to the following tools to assist the user. If you need to call a tool, reply with a markdown code block tagged json in this exact format:\n```json\n{\n  \"tool\": \"tool_name\",\n  \"arguments\": {\n    \"param\": \"value\"\n  }\n}\n```\n\nTools:\n";
  for (const t of tools) {
    const fn = t.function || t;
    prompt += `- ${fn.name}: ${fn.description || "No description"}\n  Parameters: ${JSON.stringify(fn.parameters || {})}\n`;
  }
  return prompt;
}

/**
 * 免费模型健康度与延迟监控追踪器
 * 记录连续 429 熔断、冷却时间和平均首字延迟 (TTFB)
 */
export class ModelHealthTracker {
  constructor() {
    this.stats = new Map();
  }

  getOrCreate(model) {
    if (!this.stats.has(model)) {
      this.stats.set(model, {
        streak429: 0,
        cooldownUntil: 0,
        avgLatencyMs: 300,
        callCount: 0,
        successCount: 0
      });
    }
    return this.stats.get(model);
  }

  recordSuccess(model, latencyMs) {
    const entry = this.getOrCreate(model);
    entry.streak429 = 0;
    entry.cooldownUntil = 0;
    entry.avgLatencyMs = entry.callCount === 0
      ? latencyMs
      : Math.round(entry.avgLatencyMs * 0.7 + latencyMs * 0.3);
    entry.callCount++;
    entry.successCount++;
  }

  recordFailure(model, status, isRateLimit = false) {
    const entry = this.getOrCreate(model);
    entry.callCount++;
    if (isRateLimit || status === 429) {
      entry.streak429 = (entry.streak429 || 0) + 1;
      const backoffSec = Math.min(300, 30 * Math.pow(2, entry.streak429 - 1));
      entry.cooldownUntil = Date.now() + backoffSec * 1000;
    }
  }

  isCooling(model) {
    const entry = this.stats.get(model);
    return Boolean(entry && entry.cooldownUntil > Date.now());
  }

  getScore(model) {
    const entry = this.stats.get(model);
    if (!entry) return 1000;
    if (entry.cooldownUntil > Date.now()) {
      return -10000 - (entry.cooldownUntil - Date.now());
    }
    const latencyPenalty = Math.min(600, Math.round((entry.avgLatencyMs || 300) / 2));
    return 1000 - latencyPenalty;
  }

  sortModels(models) {
    return [...models].sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  getSummary() {
    const summary = {};
    for (const [model, stat] of this.stats.entries()) {
      summary[model] = {
        latency: `${stat.avgLatencyMs}ms`,
        cooling: stat.cooldownUntil > Date.now(),
        cooldownRemainingSec: Math.max(0, Math.round((stat.cooldownUntil - Date.now()) / 1000)),
        successRate: stat.callCount > 0 ? `${Math.round((stat.successCount / stat.callCount) * 100)}%` : "N/A"
      };
    }
    return summary;
  }
}

export const globalOpenCodeHealthTracker = new ModelHealthTracker();

/**
 * 跨环境的代理请求分发器 (Node.js/Vercel/Cloudflare Workers)
 */
export async function executeFetchWithProxy(url, fetchInit, proxyUrl) {
  if (!proxyUrl) {
    return fetch(url, fetchInit);
  }

  // Node.js / Vercel: 动态载入 ProxyAgent（使用变量规避 esbuild 静态解析打包）
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      const modName = "undici";
      const { ProxyAgent } = await import(/* @vite-ignore */ modName);
      return await fetch(url, {
        ...fetchInit,
        dispatcher: new ProxyAgent(proxyUrl)
      });
    } catch (e) {
      console.warn(`[OpenCode Proxy] Failed to use undici ProxyAgent with ${proxyUrl}:`, e.message);
    }
  }

  // Cloudflare Workers 或通用转发端点: 支持带 ?url= 或代理改写
  if (proxyUrl.includes("://")) {
    try {
      if (proxyUrl.includes("?url=") || proxyUrl.endsWith("?url")) {
        const fullUrl = proxyUrl.includes("=") ? `${proxyUrl}${encodeURIComponent(url)}` : `${proxyUrl}=${encodeURIComponent(url)}`;
        return await fetch(fullUrl, {
          ...fetchInit,
          headers: {
            ...fetchInit.headers,
            "X-Target-URL": url
          }
        });
      }
    } catch (e) {}
  }

  return fetch(url, fetchInit);
}

let cachedFreeModels = null;
let cachedFreeModelsTimestamp = 0;
const MODELS_CACHE_TTL_MS = 3600 * 1000; // 1小时缓存

export class OpenCodeProvider {
  constructor(config, env) {
    this.id = config.id || "opencode";
    this.name = config.name || "OpenCode Zen (Free Tier)";
    this.type = "opencode";
    this.env = env;
    this.config = config.config || {};

    // 代理池支持：解析环境变量或配置中的代理列表
    this.proxyList = parseProxyList(this.env?.OPENCODE_PROXY_URLS || this.config.proxyUrls || this.env?.PROXY_URL || "");
    this.currentProxyIndex = 0;

    // 实例初始化时异步预热拉取官方最新免费模型
    this.fetchOfficialFreeModels().catch(() => {});
  }

  get baseUrl() {
    let url = this.config.baseUrl || "https://opencode.ai/zen/v1";
    return url.replace(/\/$/, "");
  }

  getEffectiveProxy() {
    if (this.proxyList.length === 0) return null;
    return this.proxyList[this.currentProxyIndex % this.proxyList.length];
  }

  rotateProxy() {
    if (this.proxyList.length > 0) {
      this.currentProxyIndex = (this.currentProxyIndex + 1) % this.proxyList.length;
    }
  }

  sortModelsByHealth(models) {
    return globalOpenCodeHealthTracker.sortModels(models);
  }

  isModelCooling(model) {
    return globalOpenCodeHealthTracker.isCooling(model);
  }

  getModelHealth(model) {
    return globalOpenCodeHealthTracker.getOrCreate(model);
  }

  async fetchOfficialFreeModels(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedFreeModels && (now - cachedFreeModelsTimestamp < MODELS_CACHE_TTL_MS)) {
      return cachedFreeModels;
    }

    const kv = this.env?.GATEWAY_KV || this.env?.WORKBUDDY_KV;
    if (!forceRefresh && kv) {
      try {
        const raw = await kv.get("OPENCODE_FREE_MODELS");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            cachedFreeModels = parsed;
            cachedFreeModelsTimestamp = now;
            return parsed;
          }
        }
      } catch (e) {}
    }

    try {
      const resp = await executeFetchWithProxy(`${this.baseUrl}/models`, {
        headers: {
          "User-Agent": "opencode/1.18.30",
          "x-opencode-client": "cli"
        },
        signal: AbortSignal.timeout(6000)
      }, this.getEffectiveProxy());

      if (resp.ok) {
        const json = await resp.json();
        const models = (json.data || [])
          .map(m => m.id)
          .filter(isFreeModel);

        if (models.length > 0) {
          const merged = Array.from(new Set([...models, ...DEFAULT_FREE_MODELS]));
          cachedFreeModels = merged;
          cachedFreeModelsTimestamp = now;
          if (kv) {
            try {
              await kv.put("OPENCODE_FREE_MODELS", JSON.stringify(merged));
            } catch (e) {}
          }
          console.log(`[OpenCode] Auto-synced ${merged.length} official free models from upstream`);
          return merged;
        }
      }
    } catch (err) {
      console.warn(`[OpenCode] Failed to fetch official models, falling back to cached/default:`, err.message);
    }

    cachedFreeModels = DEFAULT_FREE_MODELS;
    cachedFreeModelsTimestamp = now;
    return DEFAULT_FREE_MODELS;
  }

  getFreeModels() {
    return cachedFreeModels || DEFAULT_FREE_MODELS;
  }

  resolveModel(modelName) {
    if (!modelName) return "mimo-v2.5-free";
    let target = modelName.trim();

    // 友好别名映射到官方实际免费模型 ID
    if (target === "muse-spark-1.3") return "muse-spark-1.3-contributor-free";
    if (target === "muse-spark-1.2") return "muse-spark-1.2-contributor-free";
    if (target === "mimo-v2.5") return "mimo-v2.5-free";
    if (target === "ling-3.0-flash-fin" || target === "ling-3.0-flash") return "ling-3.0-flash-fin-free";
    if (target === "nemotron-3-ultra") return "nemotron-3-ultra-free";
    if (target === "nemotron-3.5-lightning") return "nemotron-3.5-lightning-free";
    if (target === "deepseek-v4-flash") return "deepseek-v4-flash-free";

    if (isFreeModel(target)) return target;

    // 尝试添加 -free 后缀匹配官方已同步的免费模型
    const withFree = `${target}-free`;
    const known = this.getFreeModels();
    if (known.includes(withFree)) return withFree;

    return target;
  }

  async callChat(payload, options = {}) {
    const targetModel = this.resolveModel(payload.model);

    // 仅限免费模型：严格阻断任何非免费模型的调用，避免 401 鉴权崩溃
    if (!isFreeModel(targetModel)) {
      return new Response(JSON.stringify({
        error: {
          type: "InvalidModelError",
          message: `Model "${payload.model}" is not an OpenCode free tier model. OpenCode Zen provider strictly supports free models only.`
        }
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const adaptedPayload = { ...payload, model: targetModel };

    // 自动适配：muse-spark 在 OpenCode Zen 后端仅部署于 /zen/v1/responses 端点
    if (targetModel.includes("muse-spark")) {
      return this.callResponsesApi(adaptedPayload, options);
    }

    const fingerprint = await deriveSessionAndFingerprint(payload, options);
    const url = `${this.baseUrl}/chat/completions`;

    const baseHeaders = {
      "Content-Type": "application/json",
      "User-Agent": fingerprint.userAgent,
      "x-opencode-version": fingerprint.version,
      "x-opencode-session": fingerprint.sessionId,
      "x-opencode-request": fingerprint.requestId,
      "x-opencode-client": "cli",
      "Accept": payload.stream !== false ? "text/event-stream, application/json" : "application/json",
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    const maxAttempts = Math.max(1, Math.min(this.proxyList.length, 3));
    let lastResp = null;
    let activePayload = adaptedPayload;
    let toolPolyfilled = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const currentProxy = this.getEffectiveProxy();
      const startTime = Date.now();

      const resp = await executeFetchWithProxy(url, {
        method: "POST",
        headers: { ...baseHeaders, "x-opencode-request": crypto.randomUUID() },
        body: JSON.stringify(activePayload),
        signal: options.signal,
        keepalive: true
      }, currentProxy);

      const elapsed = Date.now() - startTime;

      if (resp.ok) {
        globalOpenCodeHealthTracker.recordSuccess(targetModel, elapsed);
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: buildResponseHeaders(resp.headers, {
            "X-Gateway-Account": "opencode-zen",
            "X-Gateway-Account-Id": "opencode-zen",
            "X-Gateway-Latency": `${elapsed}ms`,
            ...(currentProxy ? { "X-Gateway-Proxy": "true" } : {})
          })
        });
      }

      const errText = await resp.text();
      const lowerErr = errText.toLowerCase();
      const isRateLimit = resp.status === 429 || lowerErr.includes("freeusagelimiterror") || lowerErr.includes("rate limit");

      if (isRateLimit) {
        globalOpenCodeHealthTracker.recordFailure(targetModel, resp.status, true);
        if (this.proxyList.length > 1 && attempt < maxAttempts - 1) {
          console.warn(`[OpenCode Proxy] IP rate limit hit on proxy ${currentProxy || "direct"}, rotating to next proxy...`);
          this.rotateProxy();
          continue;
        }
      } else {
        globalOpenCodeHealthTracker.recordFailure(targetModel, resp.status, false);
      }

      // Tool Use 兼容性降级补丁：若上游对原生 tools 报错 400，自动将 tools 转为 System Prompt 指令
      if (resp.status === 400 && !toolPolyfilled && activePayload.tools && (lowerErr.includes("tools") || lowerErr.includes("parameter"))) {
        console.warn(`[OpenCode Tools Polyfill] Model "${targetModel}" does not accept native tools, falling back to Prompt-based polyfill...`);
        toolPolyfilled = true;
        const toolPrompt = convertToolsToSystemPrompt(activePayload.tools);
        const polyfillMessages = [...(activePayload.messages || [])];
        if (polyfillMessages.length > 0 && polyfillMessages[0].role === "system") {
          polyfillMessages[0] = { ...polyfillMessages[0], content: polyfillMessages[0].content + toolPrompt };
        } else {
          polyfillMessages.unshift({ role: "system", content: toolPrompt });
        }
        const { tools, tool_choice, ...rest } = activePayload;
        activePayload = { ...rest, messages: polyfillMessages };
        continue;
      }

      lastResp = new Response(errText, {
        status: resp.status,
        headers: buildResponseHeaders(resp.headers, {
          "Content-Type": "application/json",
          "X-Gateway-Account": "opencode-zen",
          "X-Gateway-Account-Id": "opencode-zen"
        })
      });
      break;
    }

    return lastResp;
  }

  async callResponsesApi(payload, options = {}) {
    const url = `${this.baseUrl}/responses`;
    const fingerprint = await deriveSessionAndFingerprint(payload, options);

    let targetModel = payload.model;
    if (targetModel === "muse-spark-1.3") targetModel = "muse-spark-1.3-contributor-free";
    if (targetModel === "muse-spark-1.2") targetModel = "muse-spark-1.2-contributor-free";

    const baseHeaders = {
      "Content-Type": "application/json",
      "User-Agent": fingerprint.userAgent,
      "x-opencode-version": fingerprint.version,
      "x-opencode-session": fingerprint.sessionId,
      "x-opencode-request": fingerprint.requestId,
      "x-opencode-client": "cli",
      "Accept": payload.stream !== false ? "text/event-stream, application/json" : "application/json",
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    const isStream = payload.stream !== false;
    const responsesPayload = {
      model: targetModel,
      input: transformOpenAIMessagesToResponsesInput(payload.messages),
      stream: isStream
    };
    if (payload.temperature !== undefined) responsesPayload.temperature = payload.temperature;
    if (payload.top_p !== undefined) responsesPayload.top_p = payload.top_p;
    if (payload.max_tokens !== undefined) {
      responsesPayload.max_output_tokens = Math.max(payload.max_tokens, 1024);
    }
    if (payload.reasoning) {
      responsesPayload.reasoning = payload.reasoning;
    } else if (payload.reasoning_effort) {
      responsesPayload.reasoning = { effort: payload.reasoning_effort };
    }

    // Claude Code Tool Calling 深度支持：透传 tools 与 tool_choice 到 Responses API
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      responsesPayload.tools = payload.tools.map(t => {
        if (t.type === "function" && t.function) {
          return {
            type: "function",
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters || {}
          };
        }
        return t;
      });
      if (payload.tool_choice) {
        responsesPayload.tool_choice = payload.tool_choice;
      }
    }

    const maxAttempts = Math.max(1, Math.min(this.proxyList.length, 3));
    let resp = null;
    let currentProxy = null;
    let elapsed = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      currentProxy = this.getEffectiveProxy();
      const startTime = Date.now();

      resp = await executeFetchWithProxy(url, {
        method: "POST",
        headers: { ...baseHeaders, "x-opencode-request": crypto.randomUUID() },
        body: JSON.stringify(responsesPayload),
        signal: options.signal,
        keepalive: true
      }, currentProxy);

      elapsed = Date.now() - startTime;

      if (resp.ok) {
        globalOpenCodeHealthTracker.recordSuccess(targetModel, elapsed);
        break;
      }

      const isRateLimit = resp.status === 429;
      globalOpenCodeHealthTracker.recordFailure(targetModel, resp.status, isRateLimit);
      if (isRateLimit && this.proxyList.length > 1 && attempt < maxAttempts - 1) {
        console.warn(`[OpenCode Proxy] IP rate limit hit on proxy ${currentProxy || "direct"}, rotating to next proxy...`);
        this.rotateProxy();
        continue;
      }
      break;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(errText, {
        status: resp.status,
        headers: buildResponseHeaders(resp.headers, {
          "Content-Type": "application/json",
          "X-Gateway-Account": "opencode-zen",
          "X-Gateway-Account-Id": "opencode-zen"
        })
      });
    }

    if (!isStream) {
      const json = await resp.json();
      let text = "";
      const toolCalls = [];

      for (const item of (json.output || [])) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              text += part.text;
            }
          }
        } else if (item.type === "function_call" || item.type === "tool_call") {
          toolCalls.push({
            id: item.call_id || item.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            type: "function",
            function: {
              name: item.name || item.function?.name,
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
            }
          });
        }
      }

      const openaiMessage = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) {
        openaiMessage.tool_calls = toolCalls;
      }

      const openaiJson = {
        id: json.id || ("chatcmpl-" + crypto.randomUUID()),
        object: "chat.completion",
        created: json.created_at || Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            message: openaiMessage,
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
          }
        ],
        usage: {
          prompt_tokens: json.usage?.input_tokens || 15,
          completion_tokens: json.usage?.output_tokens || 10,
          total_tokens: json.usage?.total_tokens || 25
        }
      };

      return new Response(JSON.stringify(openaiJson), {
        status: 200,
        headers: buildResponseHeaders(resp.headers, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Gateway-Account": "opencode-zen",
          "X-Gateway-Account-Id": "opencode-zen",
          "X-Gateway-Latency": `${elapsed}ms`
        })
      });
    }

    // 将 Responses API 的 SSE 流实时转译为标准 OpenAI SSE 流（支持 text 和 tool_calls）
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      const reader = resp.body.getReader();
      let buffer = "";
      let hasToolCalls = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let pos = 0, lineEnd;
          while ((lineEnd = buffer.indexOf("\n", pos)) !== -1) {
            const line = buffer.slice(pos, lineEnd).trim();
            pos = lineEnd + 1;
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const parsed = JSON.parse(raw);
              if (parsed.type === "response.output_text.delta" && parsed.delta) {
                const openaiChunk = {
                  choices: [
                    {
                      delta: {
                        content: parsed.delta
                      }
                    }
                  ]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
              } else if (parsed.type === "response.output_item.added" && parsed.item?.type === "function_call") {
                hasToolCalls = true;
                const chunk = {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: parsed.output_index || 0,
                            id: parsed.item.id || `call_${crypto.randomUUID().slice(0, 8)}`,
                            type: "function",
                            function: {
                              name: parsed.item.name || "tool",
                              arguments: ""
                            }
                          }
                        ]
                      }
                    }
                  ]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } else if (parsed.type === "response.function_call_arguments.delta") {
                hasToolCalls = true;
                const chunk = {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: parsed.output_index || 0,
                            function: {
                              arguments: parsed.delta || ""
                            }
                          }
                        ]
                      }
                    }
                  ]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } else if (parsed.type === "response.completed") {
                const finishReason = hasToolCalls ? "tool_calls" : "stop";
                await writer.write(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`));
              }
            } catch (e) {}
          }
          buffer = pos > 0 ? buffer.slice(pos) : buffer;
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        try { await writer.abort(err); } catch (e) {}
      } finally {
        try { await writer.close(); } catch (e) {}
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: buildResponseHeaders(resp.headers, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Gateway-Account": "opencode-zen",
        "X-Gateway-Account-Id": "opencode-zen",
        "X-Gateway-Latency": `${elapsed}ms`
      })
    });
  }

  async getBalance() {
    return {
      success: true,
      balance: "∞ (Free Tier)",
      total: "∞",
      unit: "次",
      accounts_count: 1,
      proxies_count: this.proxyList.length,
      current_proxy: this.getEffectiveProxy() ? "(configured)" : "direct",
      health_status: globalOpenCodeHealthTracker.getSummary(),
      extra: "OpenCode Zen (Auto-Synced Free Models with Health-Scored Dynamic Routing & Proxy Cycling)"
    };
  }

  async onSchedule() {
    // 定时触发：从 OpenCode 官方 API 自动同步最新的免费模型库
    try {
      await this.fetchOfficialFreeModels(true);
    } catch (e) {
      console.error("[OpenCode] Cron model sync failed:", e.message);
    }
  }
}

/**
 * 将 OpenAI 格式的 messages 转换为 OpenCode /zen/v1/responses 所需的 input 列表
 * - 支持 user, system, assistant 文本消息 (确保 content 为字符串且非 null)
 * - 支持 assistant.tool_calls 拆解为 function_call 节点
 * - 支持 role: "tool" 转换为 function_call_output 节点
 * - 自动成对闭合 function_call 与 function_call_output，防止上游 400 报错
 */
export function transformOpenAIMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages)) return [];

  const input = [];
  const emittedCallIds = new Set();
  const pendingCallIds = new Set();

  for (const msg of messages) {
    if (!msg) continue;

    // 1. 处理 tool 角色（工具执行结果转换为 function_call_output）
    if (msg.role === "tool") {
      const callId = msg.tool_call_id || (msg.id ? String(msg.id) : null) || `call_anon_${input.length}`;
      let contentStr = "";
      if (typeof msg.content === "string") {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content.map(c => typeof c === "string" ? c : (c.text || JSON.stringify(c))).join("\n");
      } else if (msg.content !== null && msg.content !== undefined) {
        contentStr = JSON.stringify(msg.content);
      }

      // Responses API 强制要求：每个 function_call_output 前面必须有相同 call_id 的 function_call
      if (!emittedCallIds.has(callId)) {
        input.push({
          type: "function_call",
          call_id: callId,
          name: "tool",
          arguments: "{}"
        });
        emittedCallIds.add(callId);
      }

      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentStr
      });
      pendingCallIds.delete(callId);
      continue;
    }

    // 2. 处理 assistant 角色（包含普通文本以及 tool_calls）
    if (msg.role === "assistant") {
      let textContent = "";
      if (typeof msg.content === "string") {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        textContent = msg.content.map(c => typeof c === "string" ? c : (c.text || "")).join("\n").trim();
      }

      if (textContent) {
        input.push({
          role: "assistant",
          content: textContent
        });
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const callId = tc.id || `call_${crypto.randomUUID().slice(0, 8)}`;
          const funcName = tc.function?.name || tc.name || "tool";
          const args = typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || tc.arguments || {});

          emittedCallIds.add(callId);
          pendingCallIds.add(callId);
          input.push({
            type: "function_call",
            call_id: callId,
            name: funcName,
            arguments: args
          });
        }
      } else if (!textContent) {
        // 保证 content 为字符串而非 null，防止上游 400 content did not match any supported type
        input.push({
          role: "assistant",
          content: ""
        });
      }
      continue;
    }

    // 3. 处理 user / system / developer 等常规角色
    const role = (msg.role === "developer" || msg.role === "system") ? "system" : "user";
    let contentStr = "";
    if (typeof msg.content === "string") {
      contentStr = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentStr = msg.content.map(c => typeof c === "string" ? c : (c.text || JSON.stringify(c))).join("\n");
    } else if (msg.content !== null && msg.content !== undefined) {
      contentStr = String(msg.content);
    }

    input.push({
      role: role,
      content: contentStr
    });
  }

  // 4. 清理遗留未闭合的 function_call
  for (const pendingId of pendingCallIds) {
    input.push({
      type: "function_call_output",
      call_id: pendingId,
      output: "[Completed]"
    });
  }

  return input;
}

