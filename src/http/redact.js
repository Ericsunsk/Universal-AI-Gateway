// 上游文本脱敏 —— 所有回吐给客户端的上游原文的唯一出口。
// 上游响应体不可信，可能含内部端点 / 凭据 / 内网 IP；客户端回执与日志一律经此处收敛，
// 不再各处手写正则分叉。failover（core）与 exchange 共用，故放在 http 层，避免 core↔exchange 循环依赖。
export const UPSTREAM_ERR_MAX = 300;

export function redactUpstreamText(text) {
  if (typeof text !== "string" || text.length === 0) return "Upstream rejected the request";
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")        // 内部端点
    .replace(/\b(?:sk|sk-ant|Bearer|api[-_]?key|token)[-\s:=]*[A-Za-z0-9_\-.]{8,}/gi, "<credential>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")     // 内网 / 回环地址
    .slice(0, UPSTREAM_ERR_MAX);
}
