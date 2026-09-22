// 路由与故障转移 —— 模型解析、候选遍历、故障转移（cooldown/retry 经 scheduler.classify 判定）。
// 转译细节在 ./transform.js 与 ./stream.js，本模块只做编排。
import { corsHeaders } from "../http/headers.js";
import { parseReasoningIntent, applyReasoningToPayload } from "./reasoning.js";
import { isModelLevelError } from "../core/scheduler.js";
import { hasCallChat, hasCallMessages, wantsStreamedChat } from "../core/contract.js";
import { runFailover } from "../core/failover.js";
import { transformAnthropicToOpenAI } from "./transform.js";
import { streamOpenAIToAnthropic, formatOpenAIToAnthropicJson } from "./stream.js";

/**
 * Deep Exchange Module:
 * 单一深度接口，封装完整的协议探测、跨协议转译、指纹清洗、优先级回退与流式输出
 */
// 客户端错误直返（400 参数校验 / 404 模型未知）：不进故障转移，两处 short-circuit 共用。
function clientError(status, message) {
  return { done: new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  }) };
}
export async function dispatchExchange({
  protocol,
  model,
  body,
  fleet,
  config,
  request
}) {
  const isAnthropic = protocol === "anthropic";
  const routes = config.routes || {};
  // 共享解析推理强度与干净模型名
  const reasoningIntent = parseReasoningIntent({ model, body });
  const cleanModel = reasoningIntent.cleanModel || "deepseek-v4.1-flash";
  let candidates = routes[model] || routes[cleanModel];

  // 路由模糊回退已改为显式 opt-in（issue #04）。
  // 仅当 routes 中存在精确匹配时才使用配置的路由，否则返回 404 错误并提供可用模型建议。
  if (!candidates || candidates.length === 0) {
    const availableModels = Object.keys(routes || {});
    return new Response(JSON.stringify({
      error: {
        message: `No route configured for model "${model}". ` +
          `Available models: ${availableModels.length > 0 ? availableModels.join(", ") : "(none)"}. ` +
          `To use this model, please add an explicit route in the configuration.`
      }
    }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 候选级故障转移收敛到 runFailover（见 src/core/failover.js）：循环、分类、耗尽收尾
  // 由驱动器统一处理；单个候选的“试一次”（取 provider → 调上游 → 成功渲染 / 失败收口）见 attempt。
  return await runFailover(candidates, {
    onRetryable: async (candidate, action, fail) => {
      console.warn(`[Fallback] Provider "${candidate.provider}" (${candidate.model}) returned ${fail.status}, retrying next candidate...`);
    },
    renderExhausted: ({ lastError }) => new Response(JSON.stringify({
      error: {
        message: `All available providers for model "${model}" failed. Last error: ${lastError ? lastError.message : "none"}`
      }
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    }),
    attempt: async (candidate, candidateIndex) => {
      const provider = fleet.getProvider(candidate.provider);
      if (!provider) {
        // 明确报错：路由指向了不存在的 provider，而不是静默跳过
        console.error(`[Exchange] Route candidate "${candidate.provider}" not found in provider fleet`);
        throw new Error(`Provider "${candidate.provider}" not configured`);
      }

      // 能力探针（contract.js）：原生 Anthropic 上游走 callMessages，其余走 callChat；
      // 是否强制流由 adapter 以 forceStream 声明。绝不 switch provider.type。
      const nativeAnthropic = hasCallMessages(provider);
      let upstreamRes = null;

      try {
        if (isAnthropic && nativeAnthropic) {
          const anthropicPayload = applyReasoningToPayload({ ...body, model: candidate.model }, reasoningIntent, "anthropic", candidate.model);
          upstreamRes = await provider.callMessages(anthropicPayload, { signal: request?.signal, request });
        } else if (hasCallChat(provider)) {
          let openaiPayload;
          try {
            openaiPayload = isAnthropic
              ? transformAnthropicToOpenAI(body, candidate.model, config, reasoningIntent)
              : { ...body, model: candidate.model };
          } catch (err) {
            // 参数校验失败（400 / 404）：直接返回，不进行故障转移
            if (err.status === 400 || err.status === 404) {
              return clientError(err.status, err.message);
            }
            throw err;
          }
          // 推理适配恰好一次：transformAnthropicToOpenAI 的输出已是 OpenAI 方言（含映射，幂等，
          // 无需二次 apply）；唯 WorkBuddy 上游拒收推理参数，需清洗一次。OpenAI 协议客户端
          // 直传 payload，未经过 transform，仍需按方言完整适配一次。
          // 方言身份（workbuddy 清洗 vs openai 映射）集中判定于此，不再散落多处拼写。
          if (!isAnthropic || provider.type === "workbuddy") {
            applyReasoningToPayload(openaiPayload, reasoningIntent, provider.type === "workbuddy" ? "workbuddy" : "openai", candidate.model);
          }
          if (wantsStreamedChat(provider)) {
            openaiPayload.stream = true;
          }
          upstreamRes = await provider.callChat(openaiPayload, { signal: request?.signal, request });
        } else {
          throw new Error(`Provider "${candidate.provider}" implements neither callChat nor callMessages`);
        }
      } catch (err) {
        // 上游抛出的客户端错误（400 / 404）：直接返回，不进行故障转移
        if (err.status === 400 || err.status === 404) {
          return clientError(err.status, err.message);
        }
        console.warn(`[Fallback] Provider "${candidate.provider}" failed: ${err.message}, retrying next candidate...`);
        throw err;
      }

      if (upstreamRes && upstreamRes.ok) {
        const hitAccount = upstreamRes.headers.get("x-gateway-account") || "default";
        const isFallback = candidateIndex > 0;
        const debugHeaders = {
          "X-Gateway-Account": hitAccount,
          "X-Gateway-Model": candidate.model,
          "X-Gateway-Fallback": isFallback ? "true" : "false"
        };

        if (isAnthropic && !nativeAnthropic) {
          if (body.stream !== false) {
            return { done: streamOpenAIToAnthropic(upstreamRes, model, request?.signal, debugHeaders) };
          } else {
            return { done: await formatOpenAIToAnthropicJson(upstreamRes, model, debugHeaders) };
          }
        }

        return { done: new Response(upstreamRes.body, {
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
        // 尝试解析 JSON 以进行结构化错误码判定；分类本身由驱动器经 classify 完成
        let parsedErrJson = null;
        try { parsedErrJson = JSON.parse(errText); } catch (e) {}
        // 模型身份级错误（上游说“此模型不可用”）且后面还有不同模型的候选：
        // 对当前模型判 fatal 没有意义，强制切换，让备用模型接管。
        const laterModelsDiffer = (status === 400 || status === 404) &&
          isModelLevelError(errText) &&
          candidates.slice(candidateIndex + 1).some(c => c.model !== candidate.model);
        if (laterModelsDiffer) {
          console.warn(`[Fallback] Provider "${candidate.provider}" model "${candidate.model}" unavailable, failing over to a different model...`);
        }
        return { fail: {
          status,
          text: errText,
          json: parsedErrJson,
          ...(laterModelsDiffer ? { force: "retry" } : {}),
          response: new Response(errText, {
            status: status,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          })
        } };
      }

      throw new Error(`Provider "${candidate.provider}" returned an empty response`);
    },
  });
}
