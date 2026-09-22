import { getConfig, VERSION } from "./config/config.js";
import { authenticateAccess } from "./auth/auth.js";
import { corsHeaders } from "./http/headers.js";
import { dispatchExchange } from "./exchange/exchange.js";
import { getProviderFleet } from "./core/fleet.js";

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

    // 1. 健康检查（公开）
    // 零可用 provider 时标记 degraded
    if (path === "/" || path === "/healthz") {
      const hasProviders = fleet.activeCount > 0;
      const status = hasProviders ? "ok" : "degraded";
      return new Response(JSON.stringify({
        status,
        service: "universal-ai-gateway",
        version: VERSION,
        providers_active: fleet.activeCount,
        models_available: Object.keys(config.routes || {}).length,
        time: new Date().toISOString()
      }), {
        status: status === "ok" ? 200 : 503,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 2. 状态检查 (/status)
    // 仅返回无害的存活信息。余额 / 签到日志 / Token 刷新时间属敏感运营数据，
    // 仅经需鉴权的 /v1/usage 对外，避免公开泄露上游账号状态。
    if (path === "/status") {
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

    // 3. 余额与积分查询 (/v1/usage 或 /usage, 兼容 CC-Switch)
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

    // 4. 每日签到与生命周期保活接口 (/checkin)
    // 需要 Master Key 或 Cron Secret：此接口会触发上游真实签到与 Token 保活，不能对普通虚拟密钥开放
    if (path === "/checkin") {
      const auth = authenticateAccess(request, config, { requireMaster: true, allowCron: true });
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
    if (path.endsWith("/models")) {
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

    // 7. OpenAI 对话接口 (/v1/chat/completions)
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
