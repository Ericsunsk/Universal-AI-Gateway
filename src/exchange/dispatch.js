// 路由与故障转移 —— 模型解析、候选遍历、故障转移（cooldown/retry 经 scheduler.classify 判定）。
// 转译细节在 ./transform.js 与 ./stream.js，本模块只做编排。
import { corsHeaders } from "../http/headers.js";
import { parseReasoningIntent, applyReasoningToPayload } from "./reasoning.js";
import { isModelLevelError } from "../core/scheduler.js";
import { log } from "../logging/logger.js";
import { hasCallChat, hasCallMessages, wantsStreamedChat, needsReasoningScrub } from "../core/contract.js";
import { runFailover } from "../core/failover.js";
import { redactUpstreamText } from "../http/redact.js";
import { transformAnthropicToOpenAI, pruneOpenAIMessages, normalizeOpenAIMessages, isCompactOpenAIRequest } from "./transform.js";
import { streamOpenAIToAnthropic, formatOpenAIToAnthropicJson } from "./stream.js";

/**
 * Deep Exchange Module:
 * 单一深度接口，封装完整的协议探测、跨协议转译、指纹清洗、优先级回退与流式输出
 */
// 客户端错误直返（400 参数校验 / 404 模型未知）：不进故障转移，两处 short-circuit 共用。
// 返回裸 Response；调用方包成 { kind:"done", response } outcome 交给 driver。
function clientError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
// 上游响应体未经校验，可能含内部端点 / 账号标识 / 配额信息 —— 回吐前脱敏。
// 本模块自身的参数校验文案（模型不存在、协议不支持）是可信的，直接透传，不必过这里。
// 上游错误回执的唯一出口：4xx 与 5xx 同一脱敏口径、同一 JSON 信封；日志只记脱敏后文本。
function upstreamErrorResponse(status, text, providerId) {
  const redacted = redactUpstreamText(text);
  if (providerId !== undefined) {
    log.warn("Upstream rejected request", { provider: providerId, status, text: redacted });
  }
  return clientError(status, redacted);
}
export async function dispatchExchange({
  protocol,
  model,
  body,
  fleet,
  config,
  request,
  principal = null
}) {
  const isAnthropic = protocol === "anthropic";
  const routes = config.routes || {};
  // 共享解析推理强度与干净模型名
  const reasoningIntent = parseReasoningIntent({ model, body });
  const cleanModel = reasoningIntent.cleanModel || model || "default";
  let candidates = routes[model] || routes[cleanModel];

  // 1. 显式路由匹配（包括推理后缀剥离后的 cleanModel）
  // 2. 通配路由 routes["*"]
  // 3. 默认上游直通：未在 routes 声明的模型直接透传默认 provider，免除硬编码映射
  // 政策说明：issue #04 时代未知模型直接 404；现改为三级回退（精确→通配→默认直通），
  // 新模型免配置即可用。代价是已鉴权客户端的未知模型名会真实打一次上游（单候选），
  // 上游拒收回 502。如需恢复严格 404，删掉通配与默认 provider（candidates 为空即 404）。
  if (!candidates || candidates.length === 0) {
    if (routes["*"] && Array.isArray(routes["*"]) && routes["*"].length > 0) {
      candidates = routes["*"].map((c) => ({
        ...c,
        model: c.model || cleanModel
      }));
    } else {
      const defaultProviderId = config.default_provider || (fleet?.getAllActive?.()[0]?.id) || "workbuddy";
      const defaultProvider = fleet?.getProvider?.(defaultProviderId);
      if (defaultProvider) {
        candidates = [{
          provider: defaultProviderId,
          model: cleanModel
        }];
      }
    }
  }

  if (!candidates || candidates.length === 0) {
    const availableModels = Object.keys(routes || {}).filter((k) => k !== "*");
    return new Response(JSON.stringify({
      error: {
        message: `No route or provider configured for model "${model}". ` +
          `Available models: ${availableModels.length > 0 ? availableModels.join(", ") : "(none)"}.`
      }
    }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 候选级故障转移收敛到 runFailover（见 src/core/failover.js）：循环、分类、retry 预算、
  // 耗尽收尾由驱动器统一处理；单个候选的「一次往返 → 一个 outcome」见 attempt。
  // 候选层不原地重试（retryBudget: 0）：不同上游的抖动差异大，切换候选比重发更快。
  return await runFailover(candidates, {
    retryBudget: 0,
    signal: request?.signal,
    onRetryable: async (candidate, action, fail) => {
      log.warn("Provider returned error, trying next candidate", { provider: candidate.provider, model: candidate.model, status: fail.status });
    },
    renderExhausted: ({ lastError, lastFail }) => new Response(JSON.stringify({
      error: {
        message: `All available providers for model "${model}" failed. Last error: ${lastError?.message || (lastFail ? `${lastFail.status ?? ""} ${redactUpstreamText(String(lastFail.text || ""))}`.trim() : "none")}`
      }
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    }),
    attempt: async (candidate, candidateIndex) => {
      const provider = fleet.getProvider(candidate.provider);
      if (!provider) {
        // 明确报错：路由指向了不存在的 provider，而不是静默跳过
        log.error("Route candidate not found in provider fleet", { provider: candidate.provider });
        throw new Error(`Provider "${candidate.provider}" not configured`);
      }

      // 能力探针（contract.js）：原生 Anthropic 上游走 callMessages，其余走 callChat；
      // 是否强制流由 adapter 以 forceStream 声明。绝不 switch provider.type。
      const nativeAnthropic = hasCallMessages(provider);
      let upstreamRes = null;

      try {
        if (isAnthropic && nativeAnthropic) {
          const anthropicPayload = applyReasoningToPayload({ ...body, model: candidate.model }, reasoningIntent, "anthropic", candidate.model);
          upstreamRes = await provider.callMessages(anthropicPayload, { signal: request?.signal, request, principal });
        } else if (hasCallChat(provider)) {
          let openaiPayload;
          try {
            openaiPayload = isAnthropic
              ? transformAnthropicToOpenAI(body, candidate.model, config, reasoningIntent)
              : { ...body, model: candidate.model, messages: normalizeOpenAIMessages(pruneOpenAIMessages(body.messages, isCompactOpenAIRequest(body.messages))) };
          } catch (err) {
            // 参数校验失败（400 / 404）：直接返回，不进行故障转移
            if (err.status === 400 || err.status === 404) {
              return { kind: "done", response: clientError(err.status, err.message) };
            }
            throw err;
          }
          // 推理适配恰好一次：transformAnthropicToOpenAI 的输出已是 OpenAI 方言（含映射，幂等，
          // 无需二次 apply）；唯 WorkBuddy 上游拒收推理参数，需清洗一次。OpenAI 协议客户端
          // 直传 payload，未经过 transform，仍需按方言完整适配一次。
          // 方言身份经能力谓词判定（needsReasoningScrub），不 switch provider.type。
          const scrub = needsReasoningScrub(provider);
          if (!isAnthropic || scrub) {
            applyReasoningToPayload(openaiPayload, reasoningIntent, scrub ? "workbuddy" : "openai", candidate.model);
          }
          if (wantsStreamedChat(provider)) {
            openaiPayload.stream = true;
          }
          upstreamRes = await provider.callChat(openaiPayload, { signal: request?.signal, request, principal });
        } else {
          // OpenAI 协议 + 纯 Anthropic 上游：网关暂不支持该组合，转 400 而非静默切换。
          return { kind: "done", response: clientError(400, `Provider "${candidate.provider}" does not support OpenAI chat protocol`) };
        }
      } catch (err) {
        // 上游抛出的客户端错误（400 / 404）：直接返回，不进行故障转移
        if (err.status === 400 || err.status === 404) {
          return { kind: "done", response: clientError(err.status, err.message) };
        }
        log.warn("Provider threw, trying next candidate", { provider: candidate.provider, error: err.message });
        throw err;
      }

      if (upstreamRes && upstreamRes.ok) {
        // 归因头仅对 master 下发：账号 ID / 模型 / fallback 位不对客户端 key 暴露。
        const exposeDebug = principal?.isMaster === true;
        const hitAccount = upstreamRes.headers.get("x-gateway-account") || "default";
        const isFallback = candidateIndex > 0;
        const debugHeaders = exposeDebug ? {
          "X-Gateway-Account": hitAccount,
          "X-Gateway-Model": candidate.model,
          "X-Gateway-Fallback": isFallback ? "true" : "false"
        } : {};

        if (isAnthropic && !nativeAnthropic) {
          if (body.stream !== false) {
            return { kind: "done", response: streamOpenAIToAnthropic(upstreamRes, model, request?.signal, debugHeaders) };
          } else {
            return { kind: "done", response: await formatOpenAIToAnthropicJson(upstreamRes, model, debugHeaders) };
          }
        }

        return { kind: "done", response: new Response(upstreamRes.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            ...(upstreamRes.headers.get("content-type") ? { "Content-Type": upstreamRes.headers.get("content-type") } : {}),
            ...debugHeaders
          }
        }) };
      }

      if (upstreamRes) {
        const status = upstreamRes.status;
        const errText = await upstreamRes.text();
        // 分类由驱动器统一经 classifyFailure 完成：这里只交原始证据（status + text）。
        // 模型身份级错误（400/404 + isModelLevelError）且后面还有不同模型的候选时，
        // 对当前模型判 fatal 无意义，force 切换让备用模型接管（主要服务兼容上游的
        // 真实 404；WorkBuddy 走 200-业务错误路径，此处几乎不触发）。
        const laterModelsDiffer = (status === 400 || status === 404) &&
          isModelLevelError(errText) &&
          candidates.slice(candidateIndex + 1).some(c => c.model !== candidate.model);
        if (laterModelsDiffer) {
          log.warn("Model unavailable, failing over to a different model", { provider: candidate.provider, model: candidate.model });
        }
        return { kind: "switch", fail: {
          status,
          text: errText,
          ...(laterModelsDiffer ? { force: "retry" } : {}),
          // 原始 errText 只作为分类证据留在 text 字段；回吐给客户端的那份必须脱敏。
          // 4xx 与 5xx 同一出口：5xx 裸传 errText 会泄内部端点/凭据（单候选时 driver 直接返回 fail.response）。
          response: upstreamErrorResponse(status, errText, candidate.provider)
        } };
      }

      throw new Error(`Provider "${candidate.provider}" returned an empty response`);
    },
  });
}
