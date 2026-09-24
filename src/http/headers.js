// HTTP 管道 —— 与协议无关的响应头工具。被 auth / admin / exchange / providers 跨层消费，
// 是从 exchange.js 抽出的真实 seam。新增 CORS 或头过滤逻辑只改这里。

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, x-api-key, Content-Type"
};

// 响应头工具：CORS 与上游头 allowlist 透传。新增逻辑只改这里。

// 复制上游响应头，默认 allowlist 透传（content-type），其余丢弃；
// 网关自有头经 extra 叠加。避免上游注入 Location/Set-Cookie/CSP 等。
export function buildResponseHeaders(upstreamHeaders, extra = {}) {
  const headers = new Headers();
  const ct = typeof upstreamHeaders?.get === "function"
    ? upstreamHeaders.get("content-type")
    : upstreamHeaders?.["content-type"];
  if (ct) headers.set("Content-Type", ct);
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }
  return headers;
}
