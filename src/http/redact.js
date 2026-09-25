// 上游文本脱敏 —— 所有回吐给客户端的上游原文的唯一出口。
// 上游响应体不可信，可能含内部端点 / 凭据 / 内网 IP；客户端回执与日志一律经此处收敛，
// 不再各处手写正则分叉。failover（core）与 exchange 共用，故放在 http 层，避免 core↔exchange 循环依赖。
import { corsHeaders } from "./headers.js";

export const UPSTREAM_ERR_MAX = 300;

export function redactUpstreamText(text) {
  if (typeof text !== "string" || text.length === 0) return "Upstream rejected the request";
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")        // 内部端点
    .replace(/\b(?:sk|sk-ant|Bearer|api[-_]?key|token)[-\s:=]*[A-Za-z0-9_\-.]{8,}/gi, "<credential>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")     // 内网 / 回环地址
    .slice(0, UPSTREAM_ERR_MAX);
}

// ---- C2：客户端可见错误信封（failure-rendering seam）----
// 同一 JSON 信封 {error:{message}}；截断策略 UPSTREAM_ERR_MAX 在本模块接口上可见。
// 可信文本（网关自产的参数校验 / 路由文案）走 errorBody 直包，不脱敏；
// 不可信上游原文走 upstreamErrorBody，内部恰好脱敏一次——调用方传原文，禁止预脱敏。
export function errorBody(message) {
  return JSON.stringify({ error: { message: String(message ?? "") } });
}

export function upstreamErrorBody(rawText) {
  return errorBody(redactUpstreamText(rawText));
}

// dispatch 口径的预渲染响应（CORS 信封）。workbuddy 另需账号归因头，
// 故只复用 upstreamErrorBody + 自有 accountResponse 组装，不走这里。
export function upstreamErrorResponse(status, rawText, extraHeaders = {}) {
  return new Response(upstreamErrorBody(rawText), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders }
  });
}

// 耗尽收尾的可变部分：按 driver 优先级（真实最后失败为准）取原文并恰好脱敏一次。
// lastError.message 历史上原文直拼（泄漏传输层细节），现与 lastFail.text 同口径脱敏。
export function lastFailureDetail(lastError, lastFail) {
  const raw = lastError?.message || String(lastFail?.text ?? "none");
  return redactUpstreamText(raw);
}
