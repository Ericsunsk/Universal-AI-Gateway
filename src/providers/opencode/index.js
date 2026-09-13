import { buildResponseHeaders } from "../../http/headers.js";
import { matchOpenCodeFamily } from "../../exchange/reasoning.js";
import { ModelHealthTracker, globalOpenCodeHealthTracker } from "./health.js";
import { parseProxyList, executeFetchWithProxy } from "./transport.js";
import { deriveSessionAndFingerprint } from "./session.js";
import {
  buildResponsesPayload,
  renderResponsesUpstreamError,
  translateResponsesJsonToOpenAI,
  translateResponsesStreamToOpenAI,
} from "./responses.js";

// 本目录对外公开的符号（adapter 主体 + 各子模块的公开 helper），调用方只从 index 取。
export { ModelHealthTracker, globalOpenCodeHealthTracker } from "./health.js";
export { parseProxyList, executeFetchWithProxy } from "./transport.js";
export { deriveSessionAndFingerprint } from "./session.js";
export { transformOpenAIMessagesToResponsesInput } from "./responses.js";

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
    // 家族判定收敛到 reasoning.matchOpenCodeFamily，不在本文件另写 includes。
    if (matchOpenCodeFamily(targetModel) === "muse-spark") {
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

    // 别名归一收敛到 resolveModel（与 callChat 同一份映射），不另写 if 链。
    const targetModel = this.resolveModel(payload.model);

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

    const { responsesPayload, isStream } = buildResponsesPayload(payload, targetModel);

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

    if (!resp.ok) return renderResponsesUpstreamError(resp);

    if (!isStream) {
      return translateResponsesJsonToOpenAI(await resp.json(), {
        model: payload.model,
        elapsed,
        upstreamHeaders: resp.headers
      });
    }

    return translateResponsesStreamToOpenAI(resp.body, { elapsed, upstreamHeaders: resp.headers, signal: options.signal });
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
