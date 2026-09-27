// HTTP 管道 —— 与协议无关的响应头工具。被 auth / admin / exchange / providers 跨层消费，
// 是从 exchange.js 抽出的真实 seam。新增 CORS 或头过滤逻辑只改这里。

// M4 说明：默认 `*` 且**从不**发放 Access-Control-Allow-Credentials，
// 故浏览器不会自动附带 cookie 凭据；CLI / 服务端调用方不受影响。
// 若部署了**浏览器端**调用方并希望按 Origin 收敛，设置环境变量
// CORS_ALLOWED_ORIGINS='["https://app.example.com"]' 即切换为白名单回显模式。
const DEFAULT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, x-api-key, Content-Type"
};

function parseAllowedOrigins() {
  const raw = typeof process !== "undefined" && process.env?.CORS_ALLOWED_ORIGINS;
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

// 按请求 Origin 返回 CORS 头：未配置白名单时保持默认 `*`（向后兼容）；
// 配置后仅回显命中的 Origin，其余不回 CORS 头（浏览器将拦截）。
export function corsHeadersFor(request) {
  const allowed = parseAllowedOrigins();
  if (!allowed) return DEFAULT_CORS_HEADERS;
  const origin = request?.headers?.get?.("origin");
  if (origin && allowed.includes(origin)) {
    return { ...DEFAULT_CORS_HEADERS, "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  }
  return { ...DEFAULT_CORS_HEADERS, "Access-Control-Allow-Origin": "" };
}

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
