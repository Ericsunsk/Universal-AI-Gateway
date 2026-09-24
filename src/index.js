import { getConfig, VERSION } from "./config/config.js";
import { authenticateAccess, timingSafeEqual } from "./auth/auth.js";
import { corsHeaders } from "./http/headers.js";
import { dispatchExchange } from "./exchange/exchange.js";
import { getProviderFleet } from "./core/fleet.js";

// 未鉴权请求不解析 body：Content-Length 预检，超限直接 413。
// 单一来源：api/index.js（Node 层流式累积）复用同一值。
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
function bodyTooLarge(request) {
  const len = Number(request.headers.get("content-length"));
  return Number.isFinite(len) && len > MAX_BODY_BYTES;
}

export default {
  // HTTP 请求核心分发入口
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

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
        kvEnabled: !!kv
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

    // 6. Anthropic Messages 接口 (/v1/messages)
    if (path === "/messages" || path === "/v1/messages") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
      }
      // 先鉴权后解析：key 无效直接 401，不解析 body（防未授权 DoS）；
      // 模型白名单需 body.model，解析后再做第二道门。
      const preAuth = authenticateAccess(request, config);
      if (!preAuth.ok) return preAuth.response;
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
          protocol: "anthropic",
          model: requestModel,
          body: body,
          fleet: fleet,
          config: config,
          request: request,
          principal: auth.principal
        });
      } catch (err) {
        console.error("[Gateway] Anthropic dispatch failed:", err?.message || err);
        return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), {
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
        console.error("[Gateway] OpenAI dispatch failed:", err?.message || err);
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
};
