import { getConfig, VERSION } from "./config/config.js";
import { authenticateAccess } from "./auth/auth.js";
import { corsHeaders } from "./http/headers.js";
import { dispatchExchange } from "./exchange/exchange.js";
import { getProviderFleet } from "./providers/fleet.js";
import { handleAdminRequest } from "./admin/admin.js";

export default {
  // Cloudflare Cron 定时任务：触发所有已注册 Provider 的生命周期调度（签到、Token保活）
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const config = await getConfig(env);
        const fleet = getProviderFleet(config, env);
        await fleet.runScheduledTasks();
      } catch (e) {
        console.error("[Cron] Scheduled execution failed:", e);
      }
    })());
  },

  // HTTP 请求入口
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const config = await getConfig(env);
    const fleet = getProviderFleet(config, env);

    // 1. 管理后台与 Admin API
    if (path.startsWith("/admin")) {
      const auth = authenticateAccess(request, config);
      return await handleAdminRequest(request, env, auth, fleet);
    }

    // 2. 健康检查（公开）
    if (path === "/" || path === "/healthz") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "universal-ai-gateway",
        version: VERSION,
        providers_active: fleet.activeCount,
        models_available: Object.keys(config.routes || {}).length,
        time: new Date().toISOString()
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 3. 状态检查 (/status)
    if (path === "/status") {
      let lastCheckin = null;
      let lastRefresh = null;
      const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
      if (kv) {
        try {
          const raw = await kv.get("LAST_CHECKIN");
          if (raw) lastCheckin = JSON.parse(raw);
          lastRefresh = await kv.get("LAST_REFRESH");
        } catch (e) {}
      }
      const bal = await fleet.getBalance();
      return new Response(JSON.stringify({
        service: "universal-ai-gateway",
        version: VERSION,
        kvEnabled: !!kv,
        balance: bal.balance,
        lastRefresh: lastRefresh,
        lastCheckin: lastCheckin
      }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 4. 余额与积分查询 (/v1/usage 或 /usage, 兼容 CC-Switch)
    if (path.endsWith("/usage")) {
      const auth = authenticateAccess(request, config);
      if (!auth.ok) return auth.response;

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

    // 5. 手动签到接口 (/checkin)
    // 需要 Master Key 或 Cron Secret：此接口会触发上游真实签到，不能对普通虚拟密钥开放
    if (path === "/checkin") {
      const auth = authenticateAccess(request, config, { requireMaster: true });
      if (!auth.ok) return auth.response;

      const results = await fleet.runDailyCheckins();
      return new Response(JSON.stringify({ success: true, results }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 6. 模型列表接口 (/v1/models 或 /models)
    if (path.endsWith("/models")) {
      const auth = authenticateAccess(request, config);
      if (!auth.ok) return auth.response;

      const modelNames = Object.keys(config.routes || {});
      return new Response(JSON.stringify({
        object: "list",
        data: modelNames.map(id => ({
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

    // 7. Anthropic Messages 接口 (/v1/messages)
    if (path.endsWith("/messages")) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
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
          request: request
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // 8. OpenAI 对话接口 (/v1/chat/completions)
    if (path.endsWith("/chat/completions")) {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
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
          request: request
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
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
