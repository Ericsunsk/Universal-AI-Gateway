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

export function authenticateAccess(request, config, { model = null, requireMaster = false, allowCron = false } = {}) {
  const authHeader = request.headers.get("Authorization") || "";
  const xApiKey = request.headers.get("x-api-key") || "";

  let token = "";
  // 严格 token 提取：只认 `Bearer ` 前缀与 `x-api-key`。裸 Authorization
  //（无 Bearer 前缀）一律落到 Missing API Key 401，避免误记录与误命中面。
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7).trim();
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

  // 1.1 验证 Cron Secret (仅在 allowCron=true 时启用)
  // 顺序必须在 requireMaster 之前：/checkin 用 {requireMaster:true, allowCron:true}
  // 同时接受 master 与 cron（cron 降权 isMaster:false）；其他 admin 接口 allowCron=false，cron 落到下面的 requireMaster 被拒
  if (config.cron_secret && timingSafeEqual(token, config.cron_secret) && allowCron) {
    return { ok: true, principal: { isMaster: false, role: "cron", name: "Cron Trigger" } };
  }

  // 1.2 当 requireMaster 时：仅 Master Key 可访问（cron 已在上一步按 allowCron 处理）
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
  const keyObj = Object.hasOwn(virtualKeys, token) ? virtualKeys[token] : undefined;
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
      // 鉴权门与路由一致：推理后缀（model[high]）先剥离再判白名单，
      // 否则允许名单中的干净模型加后缀即 403。
      const clean = String(model).replace(/(\[[^\]]*\]\s*)+$/, "").trim();
      if (!keyObj.models.includes(model) && !keyObj.models.includes(clean)) {
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