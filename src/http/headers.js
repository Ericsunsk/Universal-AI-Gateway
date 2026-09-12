// HTTP 管道 —— 与协议无关的响应头工具。被 auth / admin / exchange / providers 跨层消费，
// 是从 exchange.js 抽出的真实 seam。新增 CORS 或头过滤逻辑只改这里。

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

// 逐跳（hop-by-hop）响应头：转发上游响应时必须剔除，否则分帧会被这些头破坏
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "set-cookie", "content-length"
]);

// 复制上游响应头，剔除逐跳头，再叠加网关自有头。返回一个干净的 Headers。
export function buildResponseHeaders(upstreamHeaders, extra = {}) {
  const headers = new Headers();
  upstreamHeaders.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }
  return headers;
}
