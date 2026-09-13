import { sanitizeMessages } from "../exchange/sanitizer.js";
import { buildResponseHeaders } from "../http/headers.js";
import {
  orderAccounts,
  computeCooldown,
  backoffMinutesForStreak
} from "./scheduler.js";

// ByteDance Trae (formerly MarsCode / 豆包) provider.
//
// 事实来源：官方 VS Code 扩展静态解混淆（scripts/decode-trae.js）+ 活客户端 v3.5.91 抓包
// （见 references/trae.md）。以活客户端为权威——它揭示的当前后端推翻了若干 bundle 旧结论。
//
// 与 WorkBuddy 的关键差异：
//   - 鉴权是 OAuth 2.0 Authorization Code + PKCE 循环回环（RFC 8252），非 Device Flow。
//     token host = grow-normal.traeapi.us；client_id = ono9krqynydwx5；app_id = 677332。
//   - 代码补全走 core-normal.traeapi.us/api/ide/v1/super_completion（SSE 流式）。
//   - 无「签到额度」机制（不像腾讯 CodeBuddy 的 day_login），故不实现 doDailyCheckin。
//   - 余额/付费状态来自 grow-normal.traeapi.us/trae/api/v1/pay/ide_user_pay_status。

// 内存级 token 缓存：accountKey -> { token, timestamp }
const traeTokenCache = new Map();
const TRAE_TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

// 账号 429 / 额度耗尽动态退避记录（进程内写穿；跨 isolate 由 KV 持久化）。
const traeCooldownRecord = new Map();
const TRAE_COOLDOWN_KV_PREFIX = "TRAE_COOLDOWN_";
const TRAE_COOLDOWN_KV_MAX_TTL_S = 900;
let traeRoundRobinCounter = 0;

let traeLastHydrateTimestamp = 0;
const TRAE_HYDRATE_THROTTLE_MS = 5 * 1000;

// 活客户端确认的生产标识（权威，来自真实请求头日志）。
// 注意：代码补全（super_completion）的 X-App-Id 是 UUID，不是 ckg 服务的数字 app_id=677332。
export const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
export const TRAE_CLIENT_ID = "ono9krqynydwx5";
// 鉴权 scheme：不是标准 Bearer，而是 Trae 私有的 "Cloud-IDE-JWT"。
export const TRAE_AUTH_SCHEME = "Cloud-IDE-JWT";

// 网关默认值（活客户端日志确认，国际版 *.traeapi.us）。region 可由 config 覆盖。
const DEFAULT_CHAT_HOST = "https://core-normal.traeapi.us"; // 核心 AI（super_completion 等）
const DEFAULT_USAGE_HOST = "https://grow-normal.traeapi.us"; // 用户/付费/额度/token

// 客户端指纹头（活客户端日志明文，缺一不可用于伪装成真实客户端）。
const DEVICE_HEADERS = {
  "User-Agent": "TTNetwork PC",
  "X-Device-Type": "mac",
  "X-Device-Cpu": "Apple",
  "X-Os-Version": "macOS 15.7.8",
  "x-plugin-channel": "icube-ai",
  "x-ide-version-code": "20260212"
};

function getKv(env) {
  return env?.GATEWAY_KV || env?.TRAE_KV || null;
}

// Trae 侧的错误分类：429 / 403 风控 / 业务额度错误 → 惩罚性退避；5xx → 切换不惩罚。
export function classifyTrae(status, bodyText = "") {
  const text = (bodyText || "").toLowerCase();
  if (status === 429) return "cooldown";
  if (status >= 500) return "retry";
  if (
    status === 403 ||
    status === 401 ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("频率限制") ||
    text.includes("额度") ||
    text.includes("余额不足") ||
    text.includes("欠费") ||
    text.includes("安全审核") ||
    text.includes("safety") ||
    text.includes("compliance")
  ) {
    return "cooldown";
  }
  return "fatal";
}

export class TraeProvider {
  constructor(config, env) {
    this.id = config.id || "trae";
    this.name = config.name || "Trae";
    this.type = "trae";
    this.env = env;
    this.config = config.config || {};
  }

  get kv() {
    return getKv(this.env);
  }

  // 账号池：支持单账号（config.accessToken/refreshToken）与多账号（config.accounts 数组）。
  // 每个账号可携带独立设备指纹（deviceId/machineId/deviceBrand），缺省回退到 config 级。
  getAccounts() {
    if (Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
      return this.config.accounts.filter((acc) => acc.enabled !== false);
    }
    const token = this.config.accessToken || this.config.jwtToken || "";
    if (!token) return [];
    return [
      {
        id: "default",
        name: this.name,
        accessToken: token,
        refreshToken: this.config.refreshToken || "",
        userId: this.config.userId || "",
        deviceId: this.config.deviceId || "",
        machineId: this.config.machineId || "",
        deviceBrand: this.config.deviceBrand || ""
      }
    ];
  }

  // 构造发给上游的请求头：Cloud-IDE-JWT 鉴权 + X-App-Id + 设备指纹 + 客户端 UA。
  buildHeaders(token, account = {}) {
    const headers = {
      ...DEVICE_HEADERS,
      "Content-Type": "application/json",
      "Authorization": `${TRAE_AUTH_SCHEME} ${token}`,
      "X-App-Id": this.appId,
      "x-ide-token": token,
      "Accept": "text/event-stream"
    };
    if (account.deviceId || this.config.deviceId) {
      headers["X-Device-Id"] = account.deviceId || this.config.deviceId;
    }
    if (account.machineId || this.config.machineId) {
      headers["X-Machine-Id"] = account.machineId || this.config.machineId;
    }
    if (account.deviceBrand || this.config.deviceBrand) {
      headers["X-Device-Brand"] = account.deviceBrand || this.config.deviceBrand;
    }
    return headers;
  }

  // 网关地址（region 可配置，默认国际版 *.traeapi.us）。
  get chatHost() {
    return this.config.chatHost || DEFAULT_CHAT_HOST;
  }

  get usageHost() {
    return this.config.usageHost || DEFAULT_USAGE_HOST;
  }

  // 代码补全端点在 core 网关上的路径（活客户端抓包确认）。
  get chatPath() {
    return this.config.chatPath || "/api/ide/v1/super_completion";
  }

  // 付费/额度状态端点（活客户端确认）。
  get payStatusPath() {
    return this.config.payStatusPath || "/trae/api/v1/pay/ide_user_pay_status";
  }

  get appId() {
    return this.config.appId || TRAE_APP_ID;
  }

  // 水合 KV 冷却记录（防抖）。
  async hydrateCooldowns(accounts, force = false) {
    const kv = this.kv;
    if (!kv || !accounts?.length) return;
    const now = Date.now();
    if (!force && now - traeLastHydrateTimestamp < TRAE_HYDRATE_THROTTLE_MS) return;
    traeLastHydrateTimestamp = now;

    const results = await Promise.allSettled(
      accounts.map((acc) => kv.get(`${TRAE_COOLDOWN_KV_PREFIX}${acc.id}`, "json"))
    );
    results.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value?.expiresAt) return;
      const record = r.value;
      if (record.expiresAt < now) return;
      const local = traeCooldownRecord.get(accounts[i].id);
      if (!local || local.expiresAt < record.expiresAt) {
        traeCooldownRecord.set(accounts[i].id, record);
      }
    });
  }

  async persistCooldown(accountId, record) {
    const kv = this.kv;
    if (!kv) return;
    const ttlS = Math.max(60, Math.min(
      Math.ceil((record.expiresAt - Date.now()) / 1000) + 60,
      TRAE_COOLDOWN_KV_MAX_TTL_S
    ));
    try {
      await kv.put(`${TRAE_COOLDOWN_KV_PREFIX}${accountId}`, JSON.stringify(record), { expirationTtl: ttlS });
    } catch (e) {
      console.error(`[Trae] Failed to persist cooldown for ${accountId}:`, e);
    }
  }

  markAccountRateLimited(accountId) {
    const record = computeCooldown(accountId, traeCooldownRecord);
    traeCooldownRecord.set(accountId, record);
    return record;
  }

  clearAccountCooldown(accountId) {
    traeCooldownRecord.delete(accountId);
    // 尽力异步清理 KV 中的持久化记录
    const kv = this.kv;
    if (kv) {
      kv.delete(`${TRAE_COOLDOWN_KV_PREFIX}${accountId}`).catch(() => {});
    }
  }

  // 获取账号的活跃 token（内存热缓存，5 分钟）。
  async getActiveToken(account) {
    const cacheKey = `${this.id}_${account.id}`;
    const now = Date.now();
    const cached = traeTokenCache.get(cacheKey);
    if (cached && now - cached.timestamp < TRAE_TOKEN_CACHE_TTL_MS) {
      return cached.token;
    }
    const token = await this.refreshAccessToken(account);
    if (token) {
      traeTokenCache.set(cacheKey, { token, timestamp: now });
    }
    return token;
  }

  // OAuth 2.0 token 刷新（Authorization Code + PKCE 循环回环签发的 token）。
  // token host = grow-normal.traeapi.us（活客户端确认）。用标准 refresh_token grant。
  // 支持无参调用（刷新全部账号），并写穿 KV 保证 Refresh Token Rotation (RTR) 跨冷启动不丢失。
  async refreshAccessToken(account = null) {
    if (!account) {
      const accounts = this.getAccounts();
      const results = await Promise.allSettled(accounts.map((acc) => this.refreshAccessToken(acc)));
      return results.map((r) => (r.status === "fulfilled" ? r.value : null)).filter(Boolean);
    }

    const cacheKey = `${this.id}_${account.id}`;
    let refreshToken = account.refreshToken || this.config.refreshToken;
    if (this.kv) {
      const cachedRefresh = await this.kv.get(`TRAE_REFRESH_TOKEN_${cacheKey}`).catch(() => null);
      if (cachedRefresh) refreshToken = cachedRefresh;
    }

    const existing = account.accessToken || this.config.accessToken;
    if (!refreshToken) return existing || null;

    try {
      const resp = await fetch(`${this.usageHost}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "xAppId": this.appId,
          "User-Agent": "TTNetwork PC"
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.config.clientId || TRAE_CLIENT_ID
        })
      });
      if (!resp.ok) {
        console.error(`[Trae:${account.name || account.id}] Token refresh failed: HTTP ${resp.status}`);
        return existing || null;
      }
      const data = await resp.json();
      const newAccess = data?.accessToken || data?.access_token || data?.token;
      if (!newAccess) return existing || null;

      account.accessToken = newAccess;
      const newRefresh = data?.refreshToken || data?.refresh_token;
      if (newRefresh) {
        account.refreshToken = newRefresh;
        if (this.kv) {
          await this.kv.put(`TRAE_REFRESH_TOKEN_${cacheKey}`, newRefresh).catch(() => {});
        }
      }
      return newAccess;
    } catch (e) {
      console.error(`[Trae:${account.name || account.id}] Token refresh error:`, e);
      return existing || null;
    }
  }

  // 核心 Chat 接口：多账号 Round-Robin + 429/额度自动故障转移 + 401 触发刷新。
  async callChat(payload, options = {}) {
    const allAccounts = this.getAccounts();
    if (allAccounts.length === 0) {
      return new Response(JSON.stringify({ error: { message: "No active Trae accounts configured" } }), { status: 500 });
    }

    await this.hydrateCooldowns(allAccounts);
    const ordered = orderAccounts(allAccounts, traeCooldownRecord, Date.now(), traeRoundRobinCounter++);
    const tried = [];
    let lastResponse = null;

    for (const account of ordered) {
      const token = await this.getActiveToken(account);
      if (!token) {
        tried.push(account.id);
        continue;
      }

      const reqHeaders = this.buildHeaders(token, account);
      const upstreamPayload = this.buildPayload(payload);

      try {
        // super_completion 本身即 SSE 流式端点（httpTimeoutConfig.sse=25），无需 ?stream= 标志。
        const resp = await fetch(`${this.chatHost}${this.chatPath}`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify(upstreamPayload)
        });

        // 401：token 过期 → 强制刷新后立即重试同账号一次。
        if (resp.status === 401) {
          tried.push(account.id);
          const refreshed = await this.refreshAccessToken(account);
          if (refreshed) {
            const cacheKey = `${this.id}_${account.id}`;
            traeTokenCache.set(cacheKey, { token: refreshed, timestamp: Date.now() });
          }
          continue;
        }

        // 读取响应体用于错误分类（不消费流式成功响应）。
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => "");
          const action = classifyTrae(resp.status, bodyText);
          if (action === "cooldown") {
            const record = this.markAccountRateLimited(account.id);
            await this.persistCooldown(account.id, record);
            console.warn(`[Trae] Account ${account.id} cooled down (${resp.status})`);
          }
          tried.push(account.id);
          lastResponse = new Response(
            JSON.stringify({ error: { message: `Trae upstream error (${resp.status})` } }),
            { status: resp.status }
          );
          continue;
        }

        // 成功：清除冷却，注入诊断头后返回流式响应。
        this.clearAccountCooldown(account.id);
        const responseHeaders = buildResponseHeaders(resp.headers, {
          "X-Gateway-Account": account.id || "primary",
          "X-Gateway-Account-Id": account.id || "primary",
          "X-Gateway-Model": options.model || payload.model || "",
          "X-Gateway-Fallback": tried.length > 0 ? "true" : "false"
        });
        if (!responseHeaders.has("Content-Type")) {
          responseHeaders.set("Content-Type", resp.headers.get("Content-Type") || "text/event-stream");
        }
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: responseHeaders
        });
      } catch (e) {
        console.error(`[Trae:${account.name || account.id}] Request error:`, e);
        tried.push(account.id);
      }
    }

    return lastResponse || new Response(JSON.stringify({ error: { message: "All Trae accounts in pool failed" } }), { status: 502 });
  }

  // 构造上游 payload：映射为 super_completion 的上下文结构。
  // 活客户端日志显示 super_completion 的请求体由 promptLib 管线组装（snippet/edit/cursor/
  // behavior/neighbor/symbol 上下文）。这里把 OpenAI 风格请求映射为最贴近的上下文字段，
  // 具体 body schema 以抓包为准（目前日志只记录端点 + 上下文构造器名，未记录完整 body）。
  buildPayload(payload) {
    const text = sanitizeMessages(payload.messages || []);
    return {
      model: payload.model || "",
      prompt: text,
      // 允许客户端下发原始上下文字段（若已按 Trae 格式构造）
      ...(payload.context ? { context: payload.context } : {}),
      ...(payload.workspacePath ? { workspace_path: payload.workspacePath } : {})
    };
  }

  // 余额 / 付费状态查询：读取 ide_user_pay_status（活客户端确认的付费/额度端点）。
  async getBalance() {
    const accounts = this.getAccounts();
    if (accounts.length === 0) {
      return { success: false, balance: 0, total: 0, unit: "quota", error: "No accounts configured" };
    }

    const results = await Promise.allSettled(accounts.map(async (acc) => {
      const token = await this.getActiveToken(acc);
      if (!token) return { id: acc.id, name: acc.name || acc.id, success: false, balance: 0 };
      const resp = await fetch(`${this.usageHost}${this.payStatusPath}`, {
        headers: this.buildHeaders(token, acc)
      });
      if (!resp.ok) return { id: acc.id, name: acc.name || acc.id, success: false, balance: 0 };
      const data = await resp.json();
      // Trae 付费状态字段名以抓包为准；这里做宽松取值，尽力暴露原始结构。
      const body = data?.data || data || {};
      return {
        id: acc.id,
        name: acc.name || acc.id,
        success: true,
        balance: body?.remaining ?? body?.balance ?? body?.quota ?? 0,
        total: body?.total ?? body?.limit ?? 0,
        raw: body
      };
    }));

    const rows = results.map((r) => (r.status === "fulfilled" ? r.value : { success: false, balance: 0 }));
    const total = rows.reduce((sum, r) => sum + (r.balance || 0), 0);
    return { success: true, balance: total, total, unit: "quota", accounts: rows };
  }

  // 定时保活：刷新账号池所有 token（无签到任务）。
  async onSchedule() {
    const accounts = this.getAccounts();
    if (accounts.length === 0) return;
    await Promise.allSettled(accounts.map((acc) => this.refreshAccessToken(acc)));
  }
}
