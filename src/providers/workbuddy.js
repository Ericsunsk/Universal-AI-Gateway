import { sanitizeMessages } from "../engine/sanitizer.js";

// 内存级多账号 Token 缓存字典: accountKey -> { token, timestamp }
const memoryTokenCache = new Map();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟热缓存

export class WorkBuddyProvider {
  constructor(config, env) {
    this.id = config.id || "workbuddy";
    this.name = config.name || "WorkBuddy";
    this.type = "workbuddy";
    this.env = env;
    this.config = config.config || {};
  }

  get kv() {
    return this.env.GATEWAY_KV || this.env.WORKBUDDY_KV;
  }

  // 获取所有启用的账号列表（支持单账号与账号池双重兼容）
  getAccounts() {
    if (Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
      return this.config.accounts.filter(acc => acc.enabled !== false);
    }
    // 降级兼顾单一账号配置
    const defaultUserId = this.config.userId || this.env.USER_ID;
    const defaultAccess = this.config.accessToken || this.env.ACCESS_TOKEN;
    const defaultRefresh = this.config.refreshToken || this.env.REFRESH_TOKEN;
    if (defaultUserId) {
      return [{
        id: "primary",
        name: "主账号",
        enabled: true,
        userId: defaultUserId,
        accessToken: defaultAccess,
        refreshToken: defaultRefresh
      }];
    }
    return [];
  }

  // 获取特定账号的有效 Token
  async getActiveToken(account) {
    const cacheKey = `${this.id}_${account.id}`;
    const now = Date.now();
    const cached = memoryTokenCache.get(cacheKey);
    if (cached && (now - cached.timestamp < TOKEN_CACHE_TTL_MS)) {
      return cached.token;
    }

    if (this.kv) {
      const kvToken = await this.kv.get(`WB_ACCESS_TOKEN_${cacheKey}`) ||
                     (account.id === "primary" ? await this.kv.get(`WB_ACCESS_TOKEN_${this.id}`) || await this.kv.get("ACCESS_TOKEN") : null);
      if (kvToken) {
        memoryTokenCache.set(cacheKey, { token: kvToken, timestamp: now });
        return kvToken;
      }
    }

    const fallback = account.accessToken || (account.id === "primary" ? this.env.ACCESS_TOKEN : "");
    if (fallback) {
      memoryTokenCache.set(cacheKey, { token: fallback, timestamp: now });
    }
    return fallback;
  }

  // 刷新特定账号的 AccessToken
  async refreshAccessToken(account) {
    const cacheKey = `${this.id}_${account.id}`;
    let refreshToken = account.refreshToken || (account.id === "primary" ? this.env.REFRESH_TOKEN : "");
    if (this.kv) {
      const cachedRefresh = await this.kv.get(`WB_REFRESH_TOKEN_${cacheKey}`) ||
                           (account.id === "primary" ? await this.kv.get(`WB_REFRESH_TOKEN_${this.id}`) || await this.kv.get("REFRESH_TOKEN") : null);
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
        memoryTokenCache.set(cacheKey, { token: newAccess, timestamp: Date.now() });

        if (this.kv) {
          await this.kv.put(`WB_ACCESS_TOKEN_${cacheKey}`, newAccess);
          if (account.id === "primary") {
            await this.kv.put(`WB_ACCESS_TOKEN_${this.id}`, newAccess);
            await this.kv.put("ACCESS_TOKEN", newAccess);
          }
          if (newRefresh) {
            await this.kv.put(`WB_REFRESH_TOKEN_${cacheKey}`, newRefresh);
            if (account.id === "primary") {
              await this.kv.put(`WB_REFRESH_TOKEN_${this.id}`, newRefresh);
              await this.kv.put("REFRESH_TOKEN", newRefresh);
            }
          }
          await this.kv.put("LAST_REFRESH", new Date().toISOString());
        }
        return newAccess;
      }
    } catch (e) {
      console.error(`[WorkBuddy:${account.name || account.id}] Token refresh failed:`, e);
    }
    return null;
  }

  // 核心 Chat 接口：支持多账号自动故障转移（Failover on 429 / Quota Error）与级联取消
  async callChat(payload, options = {}) {
    const accounts = this.getAccounts();
    if (accounts.length === 0) {
      return new Response(JSON.stringify({ error: { message: "No active WorkBuddy accounts configured" } }), { status: 500 });
    }

    if (payload.messages) {
      payload.messages = sanitizeMessages(payload.messages);
    }

    let lastResponse = null;

    for (const account of accounts) {
      let token = await this.getActiveToken(account);
      const userId = account.userId;
      if (!token || !userId) continue;

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
          body: JSON.stringify(payload),
          signal: options.signal
        });
      };

      try {
        let resp = await makeRequest(token);
        if (resp.status === 401) {
          memoryTokenCache.delete(`${this.id}_${account.id}`);
          const refreshed = await this.refreshAccessToken(account);
          if (refreshed) {
            token = refreshed;
            resp = await makeRequest(token);
          }
        }

        // 成功响应直接返回
        if (resp.ok) {
          return resp;
        }

        lastResponse = resp;
        const status = resp.status;

        // 触发账号切换条件：429 限流 / 5xx 服务异常 / 额度耗尽
        if (status === 429 || status >= 500) {
          console.warn(`[WorkBuddy] Account "${account.name || account.id}" returned ${status}, auto-switching to next account...`);
          continue;
        }

        const errText = await resp.text();
        if (errText.includes("11128") || errText.includes("quota") || errText.includes("rate limit") || errText.includes("欠费") || errText.includes("余额不足")) {
          console.warn(`[WorkBuddy] Account "${account.name || account.id}" quota/filter triggered, auto-switching to next account...`);
          continue;
        }

        // 其他不可恢复客户端错误直接返回
        return new Response(errText, {
          status: status,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        if (err.name === "AbortError") {
          throw err; // 客户端主动中断取消，直接抛出终止
        }
        console.warn(`[WorkBuddy] Account "${account.name || account.id}" network error: ${err.message}, switching next...`);
      }
    }

    return lastResponse || new Response(JSON.stringify({ error: { message: "All WorkBuddy accounts in pool failed" } }), { status: 502 });
  }

  // 余额 / 积分查询：并发聚合账号池所有账号积分
  async getBalance() {
    const accounts = this.getAccounts();
    if (accounts.length === 0) {
      return { success: false, balance: 0, total: 0, unit: "积分", error: "No accounts configured" };
    }

    const now = new Date();
    const beginTime = now.toISOString().replace("T", " ").substring(0, 19);
    const endTime = new Date(now.getTime() + 10 * 365 * 86400000).toISOString().replace("T", " ").substring(0, 19);

    const queryAccountBalance = async (account) => {
      const token = await this.getActiveToken(account);
      const userId = account.userId;
      if (!token || !userId) return { id: account.id, name: account.name, balance: 0, total: 0, success: false };

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
            id: account.id,
            name: account.name || account.id,
            balance: parseFloat(totalRemain.toFixed(2)),
            total: totalSize,
            success: true
          };
        }
      } catch (e) {
        console.error(`[WorkBuddy] Balance fetch error for ${account.name}:`, e);
      }
      return { id: account.id, name: account.name, balance: 0, total: 0, success: false };
    };

    const results = await Promise.allSettled(accounts.map(queryAccountBalance));
    let sumBalance = 0;
    let sumTotal = 0;
    const accountDetails = [];

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        sumBalance += r.value.balance || 0;
        sumTotal += r.value.total || 0;
        accountDetails.push(r.value);
      }
    }

    return {
      success: true,
      balance: parseFloat(sumBalance.toFixed(2)),
      total: sumTotal,
      unit: "积分",
      accounts_count: accounts.length,
      accounts: accountDetails,
      extra: `WorkBuddy 剩余积分 (${accounts.length}个账号池)`
    };
  }

  // 每日签到：并发对账号池内所有账号自动签到领积分
  async doDailyCheckin() {
    const accounts = this.getAccounts();
    if (accounts.length === 0) return { success: false, msg: "no accounts configured" };

    const checkinSingle = async (account) => {
      const token = await this.getActiveToken(account);
      const userId = account.userId;
      if (!token || !userId) return { id: account.id, name: account.name, success: false, msg: "missing credentials" };

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
        return {
          id: account.id,
          name: account.name || account.id,
          success: data.code === 0,
          result: data
        };
      } catch (e) {
        return { id: account.id, name: account.name, success: false, error: e.message };
      }
    };

    const results = await Promise.allSettled(accounts.map(checkinSingle));
    const checkinLogs = results.map(r => r.status === "fulfilled" ? r.value : { error: r.reason?.message });

    if (this.kv) {
      await this.kv.put("LAST_CHECKIN", JSON.stringify({
        time: new Date().toISOString(),
        provider: this.id,
        accounts_count: accounts.length,
        results: checkinLogs
      }));
    }

    return {
      success: checkinLogs.some(l => l.success),
      accounts_count: accounts.length,
      details: checkinLogs
    };
  }

  // 定时调度生命周期钩子：并发执行所有账号签到与 Token 保活
  async onSchedule() {
    await this.doDailyCheckin();
    const accounts = this.getAccounts();
    await Promise.allSettled(accounts.map(acc => this.refreshAccessToken(acc)));
  }
}
