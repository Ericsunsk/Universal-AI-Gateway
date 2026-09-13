import { getConfig, saveConfig, redactConfig, VERSION } from "../config/config.js";
import { corsHeaders } from "../http/headers.js";

export async function handleAdminRequest(request, env, authResult, fleet) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Agent-Native 自解释规范与索引（供 AI 智能体直接读取与调用）
  if (path === "/admin" || path === "/admin/") {
    return new Response(JSON.stringify({
      service: "universal-ai-gateway",
      version: VERSION,
      mode: "agent-native",
      description: "Universal AI Gateway Management API (Cloudflare Workers, Vercel, Node.js) for Autonomous Agents",
      auth: {
        type: "Bearer Token or x-api-key",
        required_key: "MASTER_KEY",
        header: "Authorization: Bearer <MASTER_KEY>"
      },
      endpoints: [
        {
          path: "/admin/api/config",
          methods: ["GET", "POST"],
          description: "Read or update gateway routing, providers, and virtual keys JSON in KV",
          requires_auth: true
        },
        {
          path: "/admin/api/status",
          methods: ["GET"],
          description: "Check real-time aggregated balance, accounts status, and last checkin logs",
          requires_auth: true
        },
        {
          path: "/admin/api/checkin",
          methods: ["POST"],
          description: "Trigger manual daily checkin across all active multi-account pools",
          requires_auth: true
        },
        {
          path: "/admin/api/refresh",
          methods: ["POST"],
          description: "Force refresh all cached and stored access tokens",
          requires_auth: true
        }
      ],
      public_endpoints: [
        { path: "/healthz", method: "GET", description: "Worker liveness heartbeat" },
        { path: "/status", method: "GET", description: "Public health summary (no sensitive data)" },
        { path: "/v1/usage", method: "GET", description: "CC-Switch compatible credit inquiry (requires API Key)" },
        { path: "/v1/models", method: "GET", description: "OpenAI-compatible models catalog (requires API Key)" },
        { path: "/v1/messages", method: "POST", description: "Anthropic Messages protocol exchange (Claude Code)" },
        { path: "/v1/chat/completions", method: "POST", description: "OpenAI Chat Completions protocol exchange" }
      ],
      authenticated: !!authResult?.ok && !!authResult?.principal?.isMaster
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
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
    // 机密字段（accessToken / refreshToken / apiKey / cron_secret 等）脱敏后再返回
    return new Response(JSON.stringify(redactConfig(config), null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  // 2. POST /admin/api/config
  // 校验只有一处：saveConfig 内的 validateConfig（状态码由抛出的 error.status 携带，
  // 这里只映射）。预检 raw 再检 merged 的双重校验已删除 —— merge 只回填机密、不改形状，
  // 同一份 schema 检两遍除了漂移（曾经 409 在这里被吞成 500）没有收益。
  if (path === "/admin/api/config" && request.method === "POST") {
    try {
      const newConfig = await request.json();
      await saveConfig(env, newConfig);
      return new Response(JSON.stringify({ success: true, message: "Configuration saved to KV successfully" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: e.message } }), {
        status: e.status || 500,
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
      service: "universal-ai-gateway",
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
