import { sanitizeMessages } from "../engine/sanitizer.js";

let memoryCachedToken = null;
let memoryCachedTokenTimestamp = 0;
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟内存热缓存，彻底规避每次对话都向 KV 查询 Token 的额外网络往返

export class WorkBuddyProvider {
  constructor(config, env) {
    this.id = config.id || "workbuddy";
    this.name = config.name || "WorkBuddy";
    this.type = "workbuddy";
    this.env = env;
    this.config = config.config || {};
  }

  get userId() {
    return this.config.userId || this.env.USER_ID;
  }

  async getActiveToken() {
    const now = Date.now();
    if (memoryCachedToken && (now - memoryCachedTokenTimestamp < TOKEN_CACHE_TTL_MS)) {
      return memoryCachedToken;
    }

    if ((this.env.GATEWAY_KV || this.env.WORKBUDDY_KV)) {
      const cached = await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).get(`WB_ACCESS_TOKEN_${this.id}`) || await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).get("ACCESS_TOKEN");
      if (cached) {
        memoryCachedToken = cached;
        memoryCachedTokenTimestamp = now;
        return cached;
      }
    }

    const fallback = this.config.accessToken || this.env.ACCESS_TOKEN;
    if (fallback) {
      memoryCachedToken = fallback;
      memoryCachedTokenTimestamp = now;
    }
    return fallback;
  }

  async refreshAccessToken() {
    let refreshToken = this.config.refreshToken || this.env.REFRESH_TOKEN;
    if ((this.env.GATEWAY_KV || this.env.WORKBUDDY_KV)) {
      const cachedRefresh = await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).get(`WB_REFRESH_TOKEN_${this.id}`) || await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).get("REFRESH_TOKEN");
      if (cachedRefresh) refreshToken = cachedRefresh;
    }
    if (!refreshToken) return null;

    try {
      const resp = await fetch("https://copilot.tencent.com/v2/plugin/auth/token/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "workbuddy",
          "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
          "Origin": "https://www.codebuddy.cn",
          "Referer": "https://www.codebuddy.cn/"
        }
      });
      const resJson = await resp.json();
      if (resJson.code === 0 && resJson.data?.accessToken) {
        const newAccess = resJson.data.accessToken;
        const newRefresh = resJson.data.refreshToken || refreshToken;

        // 立即更新内存缓存
        memoryCachedToken = newAccess;
        memoryCachedTokenTimestamp = Date.now();

        if ((this.env.GATEWAY_KV || this.env.WORKBUDDY_KV)) {
          await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).put(`WB_ACCESS_TOKEN_${this.id}`, newAccess);
          await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).put("ACCESS_TOKEN", newAccess);
          if (newRefresh) {
            await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).put(`WB_REFRESH_TOKEN_${this.id}`, newRefresh);
            await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).put("REFRESH_TOKEN", newRefresh);
          }
          await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).put("LAST_REFRESH", new Date().toISOString());
        }
        return newAccess;
      }
    } catch (e) {
      console.error(`[${this.id}] Token refresh failed:`, e);
    }
    return null;
  }

  // 核心 Chat 接口
  async callChat(payload) {
    let token = await this.getActiveToken();
    const userId = this.userId;

    if (payload.messages) {
      payload.messages = sanitizeMessages(payload.messages);
    }

    const makeRequest = async (tk) => {
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://www.codebuddy.cn",
        "Referer": "https://www.codebuddy.cn/",
        "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
        "Authorization": `Bearer ${tk}`,
        "X-User-Id": userId,
        "X-Product": "SaaS"
      };
      return await fetch("https://copilot.tencent.com/v2/chat/completions", {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload)
      });
    };

    let resp = await makeRequest(token);
    if (resp.status === 401) {
      memoryCachedToken = null; // 失效旧 token
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        token = refreshed;
        resp = await makeRequest(token);
      }
    }
    return resp;
  }

  // 余额 / 积分查询
  async getBalance() {
    const token = await this.getActiveToken();
    const userId = this.userId;
    if (!token || !userId) return { success: false, balance: 0, error: "no credentials" };

    const now = new Date();
    const beginTime = now.toISOString().replace("T", " ").substring(0, 19);
    const endTime = new Date(now.getTime() + 10 * 365 * 86400000).toISOString().replace("T", " ").substring(0, 19);

    try {
      const resp = await fetch("https://www.codebuddy.cn/v2/billing/meter/get-user-resource", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-User-Id": userId,
          "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
          "Origin": "https://www.codebuddy.cn",
          "Referer": "https://www.codebuddy.cn/",
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: "p_tcaca",
          Status: [0, 3],
          PackageEndTimeRangeBegin: beginTime,
          PackageEndTimeRangeEnd: endTime
        })
      });

      const data = await resp.json();
      if (data.code === 0 && data.data?.Response?.Data?.Accounts) {
        let totalRemain = 0;
        let totalSize = 0;
        for (const acc of data.data.Response.Data.Accounts) {
          const r = parseFloat(acc.CycleCapacityRemainPrecise || acc.CycleCapacityRemain || acc.CapacityRemain || 0);
          const s = parseFloat(acc.CycleCapacitySizePrecise || acc.CycleCapacitySize || acc.CapacitySize || 0);
          totalRemain += r;
          totalSize += s;
        }
        return {
          success: true,
          balance: parseFloat(totalRemain.toFixed(2)),
          total: totalSize,
          unit: "积分",
          extra: "WorkBuddy 剩余积分"
        };
      }
    } catch (e) {
      console.error(`[${this.id}] Fetch balance failed:`, e);
    }
    return { success: false, balance: 0, error: "Failed to parse balance" };
  }

  // 每日签到
  async doDailyCheckin() {
    const token = await this.getActiveToken();
    const userId = this.userId;
    if (!token || !userId) return { success: false, msg: "no credentials" };

    try {
      const resp = await fetch("https://www.codebuddy.cn/v2/billing/meter/daily-checkin", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-User-Id": userId,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: "{}"
      });
      const data = await resp.json();
      if ((this.env.GATEWAY_KV || this.env.WORKBUDDY_KV)) {
        await (this.env.GATEWAY_KV || this.env.WORKBUDDY_KV).put("LAST_CHECKIN", JSON.stringify({
          time: new Date().toISOString(),
          provider: this.id,
          result: data
        }));
      }
      return { success: data.code === 0, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async onSchedule() {
    await this.doDailyCheckin();
    await this.refreshAccessToken();
  }
}
