// 上游文本脱敏 —— 所有回吐给客户端的上游原文的唯一出口。
// 上游响应体不可信，可能含内部端点 / 凭据 / 内网 IP；客户端回执与日志一律经此处收敛，
// 不再各处手写正则分叉。failover（core）与 exchange 共用，故放在 http 层，避免 core↔exchange 循环依赖。
import { corsHeaders } from "./headers.js";

export const UPSTREAM_ERR_MAX = 300;

// 预编译正则（ReDoS 防护 P2-7）
const REGEX_URL = /https?:\/\/[^\s"'<>]+/gi;
const REGEX_CREDENTIAL_BARE = /\b(?:sk|sk-ant|Bearer)[-\s:=]*[A-Za-z0-9_\-.]{8,}/gi;
// L1 修复：前缀枚举永远漏（AIza… 的 Google key、纯 hex token、自定义 `Token xxx`）。
// 补一条**高熵**兜底：连续 32+ 位、且同时含字母与数字的 token 样串。
// 要求同时含字母与数字可避开普通长单词/哈希路径的中文文本误伤，
// 且 {32,} 的定长下界 + 无嵌套量词，不引入回溯爆炸。
const REGEX_HIGH_ENTROPY = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;
// 形如 `token=xxx` / `key: xxx` / `secret xxx` 的宽松兜底（含非英文字段名场景）
const REGEX_CREDENTIAL_COMPOUND = /\b(?:[\w-]*?(?:keys?|tokens?|secrets?|auth|pwd|pass(?:word|wd)?|credentials?))[-_\s:="'\\]+[A-Za-z0-9_\-.]{8,}/gi;
const REGEX_IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

// ReDoS 防护超时（worker thread 方案的简化版）
const REDACT_TIMEOUT_MS = 100;

export function redactUpstreamText(text) {
  if (typeof text !== "string" || text.length === 0) return "Upstream rejected the request";

  // 前置截断：防范大体积上游报错页面（如 50KB+ HTML）对正则引擎造成无谓的 CPU 开销与 Event Loop 冻结
  const input = text.length > 4000 ? text.slice(0, 4000) : text;

  // 超时保护：对于病态输入，限制执行时间
  const startTime = Date.now();

  try {
    let result = input;

    // 逐个正则执行，每次检查超时
    result = result.replace(REGEX_URL, "<url>");
    if (Date.now() - startTime > REDACT_TIMEOUT_MS) return "[redacted: timeout]";

    result = result.replace(REGEX_CREDENTIAL_BARE, "<credential>");
    if (Date.now() - startTime > REDACT_TIMEOUT_MS) return "[redacted: timeout]";

    result = result.replace(REGEX_CREDENTIAL_COMPOUND, "<credential>");
    if (Date.now() - startTime > REDACT_TIMEOUT_MS) return "[redacted: timeout]";

    result = result.replace(REGEX_HIGH_ENTROPY, "<credential>");
    if (Date.now() - startTime > REDACT_TIMEOUT_MS) return "[redacted: timeout]";

    result = result.replace(REGEX_IP, "<ip>");

    return result.slice(0, UPSTREAM_ERR_MAX);
  } catch (_e) {
    // 正则引擎崩溃时的降级处理
    return "[redacted: error]";
  }
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
