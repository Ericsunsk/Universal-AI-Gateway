// HTTP 管道 —— 与协议无关的响应头工具。被 auth / admin / exchange / providers 跨层消费，
// 是从 exchange.js 抽出的真实 seam。新增 CORS 或头过滤逻辑只改这里。

// CORS 策略：固定 `*`，且**从不**发放 Access-Control-Allow-Credentials，
// 故浏览器不会自动附带 cookie 凭据；CLI / 服务端调用方不受影响。
//
// 此前存在一个 CORS_ALLOWED_ORIGINS 白名单开关（parseAllowedOrigins + corsHeadersFor），
// 但从未接线：全应用 import 的是常量 corsHeaders，反射函数零调用点，于是设了该环境变量
// 也毫无效果（实测：配了白名单仍发 `*`）。已移除，避免「文档化的安全开关实际不生效」。
//
// 若将来需要按 Origin 收敛：新增按请求取头的函数，并在**所有**响应构造点替换 corsHeaders
// （src/index.js / exchange/* / auth / core/failover 共 30+ 处），而非只加一个未接线的函数。
const DEFAULT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, x-api-key, Content-Type"
};

export const corsHeaders = DEFAULT_CORS_HEADERS;

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
