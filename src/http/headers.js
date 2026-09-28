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

// Anthropic 协议版本 —— 单一真值。
//
// 此前这个字面量散在 3 处（stream.js 请求头/响应头、anthropic_standard.js 请求头），
// 且只有标准适配器认 config.anthropicVersion 覆盖，两个响应头位置不认 —— 一旦覆盖，
// 请求头与响应头会报出不同版本号。收敛到此处，三处共用同一条 fallback。
// 放在 http 层（leaf）：exchange 与 providers 都允许 import 它，不引入层级依赖。
export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

// 解析生效的 Anthropic 版本：config 覆盖优先，否则默认。
export function resolveAnthropicVersion(config) {
  return config?.anthropicVersion || DEFAULT_ANTHROPIC_VERSION;
}

// 响应头工具：CORS 与上游头 allowlist 透传。新增逻辑只改这里。

// 复制上游响应头，默认 allowlist 透传（content-type），其余丢弃；
// 网关自有头经 extra 叠加。避免上游注入 Location/Set-Cookie/CSP 等。
//
// CORS 默认合并（可经 extra 覆盖）：C2 要求「客户端可见失败走同一信封」含 CORS 头，
// 而 provider 层深处构造的失败响应（如 workbuddy 的 renderExhausted/renderFail）
// 拿不到边界处的 corsHeaders —— 此前因此漏发 ACAO，浏览器客户端只看到
// TypeError: Failed to fetch，而非精心脱敏的错误 JSON。把默认值下沉到本函数，
// 使该不变量有一个强制卡点，而非依赖每个调用点自觉。
export function buildResponseHeaders(upstreamHeaders, extra = {}, { withCors = true } = {}) {
  const headers = new Headers();
  if (withCors) {
    for (const [k, v] of Object.entries(DEFAULT_CORS_HEADERS)) headers.set(k, v);
  }
  const ct = typeof upstreamHeaders?.get === "function"
    ? upstreamHeaders.get("content-type")
    : upstreamHeaders?.["content-type"];
  if (ct) headers.set("Content-Type", ct);
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }
  return headers;
}
