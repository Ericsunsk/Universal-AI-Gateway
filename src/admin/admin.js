import { DASHBOARD_HTML } from "./dashboard.html.js";
import { getConfig, saveConfig, VERSION } from "../config.js";
import { corsHeaders } from "../engine/exchange.js";

export async function handleAdminRequest(request, env, authResult, fleet) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 网页管理面板入口（直接返回 HTML，由前端携带 Master Key 访问 API）
  if (path === "/admin" || path === "/admin/") {
    return new Response(DASHBOARD_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }

  // 后台 API 必须具有 Master Admin 权限
  if (!authResult.ok || !authResult.principal?.isMaster) {
    return new Response(JSON.stringify({ error: { message: "Master Key Required for Admin Operations" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 1. GET /admin/api/config
  if (path === "/admin/api/config" && request.method === "GET") {
    const config = await getConfig(env);
    return new Response(JSON.stringify(config, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 2. POST /admin/api/config
  if (path === "/admin/api/config" && request.method === "POST") {
    try {
      const newConfig = await request.json();
      if (!newConfig.providers || !newConfig.routes) {
        return new Response(JSON.stringify({ error: { message: "Invalid config schema: providers and routes required" } }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      await saveConfig(env, newConfig);
      return new Response(JSON.stringify({ success: true, message: "Configuration saved to KV successfully" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: e.message } }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  // 3. GET /admin/api/status
  if (path === "/admin/api/status" && request.method === "GET") {
    const config = await getConfig(env);
    let lastCheckin = null;
    let lastRefresh = null;
    const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;

    if (kv) {
      try {
        const rawCheckin = await kv.get("LAST_CHECKIN");
        if (rawCheckin) lastCheckin = JSON.parse(rawCheckin);
        lastRefresh = await kv.get("LAST_REFRESH");
      } catch (e) {}
    }

    const bal = await fleet.getBalance();

    return new Response(JSON.stringify({
      service: "worker-ai-gateway",
      version: VERSION,
      time: new Date().toISOString(),
      balance: bal.balance,
      total_balance: bal.total,
      accounts_count: bal.accounts_count || 1,
      accounts: bal.accounts || [],
      last_checkin: lastCheckin,
      last_refresh: lastRefresh,
      providers_count: fleet.activeCount,
      routes_count: Object.keys(config.routes || {}).length
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 4. POST /admin/api/checkin
  if (path === "/admin/api/checkin" && request.method === "POST") {
    const results = await fleet.runDailyCheckins();
    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 5. POST /admin/api/refresh
  if (path === "/admin/api/refresh" && request.method === "POST") {
    const results = await fleet.refreshAllTokens();
    return new Response(JSON.stringify({ success: true, results }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  return new Response(JSON.stringify({ error: { message: "Admin endpoint not found" } }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
