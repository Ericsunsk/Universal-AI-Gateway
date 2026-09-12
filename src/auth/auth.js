import { corsHeaders } from "../http/headers.js";

// 常数时间字符串比较：先比较长度，再对每个字符做等价的按位累加，避免 === 短路泄露前缀信息。
// 攻击者通过响应耗时逐字节推断 token 的时序侧信道即被消除。
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;

  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

export function authenticateAccess(request, config, { model = null, requireMaster = false } = {}) {
  const authHeader = request.headers.get("Authorization") || "";
  const xApiKey = request.headers.get("x-api-key") || "";

  let token = "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
  } else if (authHeader) {
    token = authHeader.trim();
  } else if (xApiKey) {
    token = xApiKey.trim();
  }

  if (!token) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: { message: "Missing API Key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      })
    };
  }

  // 1. 验证 Master Key
  if (config.master_key && timingSafeEqual(token, config.master_key)) {
    return { ok: true, principal: { isMaster: true, role: "admin", name: "Master Admin" } };
  }

  // 1.1 验证 Cron Secret (用于 Vercel Cron 定时任务鉴权)
  if (config.cron_secret && timingSafeEqual(token, config.cron_secret)) {
    return { ok: true, principal: { isMaster: true, role: "cron", name: "Cron Trigger" } };
  }

  if (requireMaster) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: { message: "Master Key Required" } }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      })
    };
  }

  // 2. 验证虚拟客户端密钥
  const virtualKeys = config.virtual_keys || {};
  const keyObj = virtualKeys[token];
  if (keyObj) {
    if (!keyObj.enabled) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: { message: "API Key has been disabled" } }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        })
      };
    }

    if (model && Array.isArray(keyObj.models) && !keyObj.models.includes("*")) {
      if (!keyObj.models.includes(model)) {
        return {
          ok: false,
          response: new Response(JSON.stringify({ error: { message: `Model "${model}" is not permitted for this API Key` } }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          })
        };
      }
    }

    return {
      ok: true,
      principal: { isMaster: false, role: keyObj.role || "client", name: keyObj.name || "Client" }
    };
  }

  return {
    ok: false,
    response: new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    })
  };
}
