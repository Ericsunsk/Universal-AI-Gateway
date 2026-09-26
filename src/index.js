import { getConfig, VERSION } from "./config/config.js";
import { authenticateAccess, timingSafeEqual } from "./auth/auth.js";
import { corsHeaders } from "./http/headers.js";
import { errorBody } from "./http/redact.js";
import { dispatchExchange } from "./exchange/exchange.js";
import { recordCacheControl, getCacheControlStats } from "./exchange/cacheControlStats.js";
import { getProviderFleet } from "./core/fleet.js";
import { checkRateLimit, RATE_LIMIT_PRESETS, extractRateLimitKey, rateLimitResponse } from "./ratelimit/ratelimit.js";
import { runWithLogger, extractTraceId, generateTraceId, log } from "./logging/logger.js";

// 未鉴权请求不解析 body：Content-Length 预检，超限直接 413。
// 单一来源：api/index.js（Node 层流式累积）复用同一值。
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
function bodyTooLarge(request) {
  const len = Number(request.headers.get("content-length"));
  return Number.isFinite(len) && len > MAX_BODY_BYTES;
}

export default {
  // HTTP 请求核心分发入口
  // 整个请求在 ALS 作用域内运行：任意深度的 log.* 自动携带 trace_id。
  // trace_id 优先取客户端/上游透传的 x-trace-id，无则新生成，便于跨服务串联。
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const traceId = extractTraceId(request) || generateTraceId();
    return runWithLogger({ trace_id: traceId }, () => handleRequest(request, env));
  }
};

// 处理链主体：所有分支共享同一个 ALS 作用域。
// trace_id 不经参数传入 —— 作用域内的 log.* 直接从 ALS 读取。
async function handleRequest(request, env) {
  {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = await getConfig(env);
    const fleet = getProviderFleet(config, env);

    // 1. 健康检查（公开，最小化）
    // 只回存活状态 + 时间：version / provider 数 / 模型数不再公开，
    // 避免指纹探测与运营信息泄露。零可用 provider 时标记 degraded。
    if (path === "/" || path === "/healthz") {
      const hasProviders = fleet.activeCount > 0;
      const status = hasProviders ? "ok" : "degraded";
      return new Response(JSON.stringify({
        status,
        time: new Date().toISOString()
      }), {
        status: status === "ok" ? 200 : 503,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 2. 状态检查 (/status，需鉴权)
    // version / kvEnabled 不再公开，持任意有效 key 方可查看。
    if (path === "/status") {
      const auth = authenticateAccess(request, config);
      if (!auth.ok) return auth.response;
      const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
      return new Response(JSON.stringify({
        service: "universal-ai-gateway",
        version: VERSION,
        kvEnabled: !!kv,
        // cache_control 断点观测（#12）：供决定是否做断点透传。
        // 进程级累计、随实例归零；仅持有效 key 可读，不对外公开。
        cacheControl: getCacheControlStats()
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 3. 余额与积分查询 (/v1/usage 或 /usage)
    // 仅 master / admin 角色可查：运维总余额不对普通客户端 key 开放。
    if (path === "/usage" || path === "/v1/usage") {
      const auth = authenticateAccess(request, config);
      if (!auth.ok) return auth.response;
      if (!auth.principal.isMaster && auth.principal.role !== "admin") {
        return new Response(JSON.stringify({ error: { message: "Forbidden" } }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const bal = await fleet.getBalance();
      return new Response(JSON.stringify({
        code: 0,
        data: {
          balance: bal.balance,
          total: bal.total,
          unit: bal.unit || "积分"
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 4. 每日签到与生命周期保活接口 (/checkin)
    // 需要 Master Key 或 Cron Secret：此接口会触发上游真实签到与 Token 保活，不能对普通虚拟密钥开放。
    // Vercel Cron 不发 Authorization 头：同时接受 ?secret= / x-cron-secret（与 cron_secret 比对），
    // 否则每日定时任务恒 401、保活静默失败。
    if (path === "/checkin") {
      const cronSecret = config.cron_secret || "";
      const urlSecret = url.searchParams.get("secret") || "";
      const headerSecret = request.headers.get("x-cron-secret") || "";
      const cronViaSecret = !!(cronSecret && (timingSafeEqual(urlSecret, cronSecret) || timingSafeEqual(headerSecret, cronSecret)));
      const auth = cronViaSecret
        ? { ok: true, principal: { isMaster: false, role: "cron", name: "Cron Trigger" } }
        : authenticateAccess(request, config, { requireMaster: true, allowCron: true });
      if (!auth.ok) return auth.response;

      const results = await fleet.runDailyCheckins();
      const refreshes = await fleet.refreshAllTokens();
      return new Response(JSON.stringify({ success: true, results, refreshes }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 5. 模型列表接口 (/v1/models 或 /models)
    // 注意：透明直通下 routes 默认为空，此处返回空列表是预期行为；
    // 未在 routes 声明的模型依然可直接调用（走 default_provider 直通）。
    if (path === "/models" || path === "/v1/models") {
      const auth = authenticateAccess(request, config);
      if (!auth.ok) return auth.response;

      const configuredModels = Object.keys(config.routes || {}).filter((m) => m !== "*");
      const allModels = Array.from(new Set(configuredModels));

      return new Response(JSON.stringify({
        object: "list",
        data: allModels.map(id => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "worker-gateway"
        }))
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 5.5 Anthropic count_tokens 接口 (/v1/messages/count_tokens)
    // 必须在 /v1/messages 的等值判断之前无冲突（等值比较不会误匹配子路径），
    // 但独立成段以便复用同一鉴权与限流口径。
    // Anthropic SDK / Claude Code 用它做上下文预算管理；缺此路由会 404 中断客户端。
    if (path === "/messages/count_tokens" || path === "/v1/messages/count_tokens") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
      }
      const preAuth = authenticateAccess(request, config);
      if (!preAuth.ok) return preAuth.response;

      const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
      const rateLimitKey = extractRateLimitKey(request, preAuth.principal);
      const rateLimitResult = await checkRateLimit(kv, rateLimitKey, RATE_LIMIT_PRESETS.standard);
      if (!rateLimitResult.allowed) {
        return rateLimitResponse(rateLimitResult, corsHeaders);
      }

      if (bodyTooLarge(request)) {
        return new Response(errorBody("Request body too large"), {
          status: 413,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      try {
        const body = await request.json();
        const requestModel = body?.model || "deepseek-v4.1-flash";
        const auth = authenticateAccess(request, config, { model: requestModel });
        if (!auth.ok) return auth.response;

        // 复用响应侧的字符数/4 口径，保证与实际计费口径一致。
        // 估的是入站请求的序列化长度：包含 system / messages / tools 全部字段，
        // 与上游 OpenAI 侧 tokenizer 的偏差在同一量级内 —— 客户端要的是量级不是精确值。
        const inputTokens = Math.max(1, Math.ceil(JSON.stringify(body || {}).length / 4));
        return new Response(JSON.stringify({ input_tokens: inputTokens }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch {
        // 非法 JSON：返回标准错误信封，绝不 500
        return new Response(errorBody("Invalid JSON body"), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // 6. Anthropic Messages 接口 (/v1/messages)
    if (path === "/messages" || path === "/v1/messages") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
      }
      // 先鉴权后解析：key 无效直接 401，不解析 body（防未授权 DoS）；
      // 模型白名单需 body.model，解析后再做第二道门。
      const preAuth = authenticateAccess(request, config);
      if (!preAuth.ok) return preAuth.response;

      // 限流检查（已认证用户）：标准限流（60 req/min）
      const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
      const rateLimitKey = extractRateLimitKey(request, preAuth.principal);
      const rateLimitResult = await checkRateLimit(kv, rateLimitKey, RATE_LIMIT_PRESETS.standard);
      if (!rateLimitResult.allowed) {
        return rateLimitResponse(rateLimitResult, corsHeaders);
      }

      if (bodyTooLarge(request)) {
        return new Response(errorBody("Request body too large"), {
          status: 413,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      try {
        const body = await request.json();
        const requestModel = body.model || "deepseek-v4.1-flash";

        const auth = authenticateAccess(request, config, { model: requestModel });
        if (!auth.ok) return auth.response;

        // 观测（#12）：只计数，不改变行为。用于决定是否值得做 cache_control 断点透传。
        recordCacheControl(body);

        return await dispatchExchange({
          protocol: "anthropic",
          model: requestModel,
          body: body,
          fleet: fleet,
          config: config,
          request: request,
          principal: auth.principal
        });
      } catch (err) {
        log.error("Anthropic dispatch failed", { error: err?.message || String(err) });
        return new Response(errorBody("Internal Server Error"), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // 7. OpenAI 对话接口 (/v1/chat/completions)
    if (path === "/chat/completions" || path === "/v1/chat/completions") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
      }
      const preAuth = authenticateAccess(request, config);
      if (!preAuth.ok) return preAuth.response;

      // 限流检查（已认证用户）：标准限流（60 req/min）
      const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
      const rateLimitKey = extractRateLimitKey(request, preAuth.principal);
      const rateLimitResult = await checkRateLimit(kv, rateLimitKey, RATE_LIMIT_PRESETS.standard);
      if (!rateLimitResult.allowed) {
        return rateLimitResponse(rateLimitResult, corsHeaders);
      }

      if (bodyTooLarge(request)) {
        return new Response(JSON.stringify({ error: { message: "Request body too large" } }), {
          status: 413,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      try {
        const body = await request.json();
        const requestModel = body.model || "deepseek-v4.1-flash";

        const auth = authenticateAccess(request, config, { model: requestModel });
        if (!auth.ok) return auth.response;

        return await dispatchExchange({
          protocol: "openai",
          model: requestModel,
          body: body,
          fleet: fleet,
          config: config,
          request: request,
          principal: auth.principal
        });
      } catch (err) {
        log.error("OpenAI dispatch failed", { error: err?.message || String(err) });
        return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    return new Response(JSON.stringify({ error: { message: "Endpoint Not Found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
