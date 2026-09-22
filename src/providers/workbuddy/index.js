import { sanitizeMessages } from "../../exchange/sanitizer.js";
import { buildResponseHeaders } from "../../http/headers.js";
import { orderAccounts, businessErrorCode, hashString32 } from "../../core/scheduler.js";
import { runFailover } from "../../core/failover.js";
import { accountCooldownRecord, hydrateCooldowns, setAccountCooldown } from "./cooldown.js";

// 内存级多账号 Token 缓存字典: accountKey -> { token, timestamp }
const memoryTokenCache = new Map();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟热缓存
// 显式池成员缺凭证告警去重：每账号每进程只告警一次，避免热路径刷屏
const noCredentialWarned = new Set();
let roundRobinCounter = 0;

// 抖动重试基准延迟（Q6 可配置）：env RETRY_BASE_MS，默认 600ms。
// Vercel 与 CF 超时/计费模型不同，允许两边设不同值；非法值回退默认。
export const DEFAULT_RETRY_DELAY_MS = 600;
export function retryDelayMs(env) {
  const raw = Number(env?.RETRY_BASE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.floor(raw);
}

// 显式池成员缺自身凭证时 fail-closed：env 兜底只属于无 accounts 数组时的合成单账号。
// 每个账号每进程只告警一次（调用方含请求热路径与 cron 冷路径）。
function warnNoCredential(providerId, account) {
  const key = `${providerId}_${account?.id}`;
  if (noCredentialWarned.has(key)) return;
  noCredentialWarned.add(key);
  console.warn(`[WorkBuddy] Account "${account?.name || account?.id}" has no credentials, skipping (env fallback only applies to single-account config)`);
}

// 会话粘性键：优先客户端透传的会话头；回退 system+tools 指纹
// （同一编码会话内稳定；跨会话碰撞只影响落点、不影响正确性）。
// 取不到返回 null → orderAccounts 走纯轮询。只读不写。
export function affinityKeyForCall(payload, options = {}) {
  const headers = options?.request?.headers;
  if (headers) {
    const get = (k) => typeof headers.get === "function" ? headers.get(k) : headers[k];
    const sid = get("x-session-id") || get("x-conversation-id") || get("session-id");
    if (sid) return `sid:${sid}`;
  }
  try {
    const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
    const first = msgs.length > 0 && msgs[0]?.role === "system" ? msgs[0].content : "";
    const sys = typeof first === "string" ? first : JSON.stringify(first ?? "");
    const tools = JSON.stringify(payload?.tools ?? []);
    const sig = sys + "\n" + tools;
    if (sig.trim().length > 8) return `sig:${hashString32(sig)}`;
  } catch (e) {}
  return null;
}

// Region 端点表：CN 现状冻结；intl 格子待凭证实测后填（TODO-intl）。
// provider 配置 config.region: "intl" 即切整组端点 + Origin/Referer；默认 "cn" 行为零变化。
export function normalizeWorkbuddyRegion(value) {
  return String(value || "").toLowerCase() === "intl" ? "intl" : "cn";
}

export function resolveWorkbuddyEndpoints(region) {
  if (normalizeWorkbuddyRegion(region) === "intl") {
    // 国际站（实测 2026-09-14）：CLI product.json 默认 endpoint 即 www.codebuddy.ai，
    // 鉴权同为 cli-external-link + prefixPath /plugin；refresh 空 token 回业务码 10001（应用层已说话），
    // chat/billing/checkin 同 path 在鉴权墙后（401）。与 CN 同构，唯 host 与 Origin 不同。
    return {
      region: "intl",
      probed: true,
      refresh: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
      chat: "https://www.codebuddy.ai/v2/chat/completions",
      billing: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
      checkin: "https://www.codebuddy.ai/v2/billing/meter/daily-checkin",
      origin: "https://www.codebuddy.ai",
      referer: "https://www.codebuddy.ai/",
      userAgent: "CLI/2.63.2 CodeBuddy/2.63.2"
    };
  }
  return {
    region: "cn",
    probed: true,
    refresh: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    chat: "https://copilot.tencent.com/v2/chat/completions",
    billing: "https://www.codebuddy.cn/v2/billing/meter/get-user-resource",
    checkin: "https://www.codebuddy.cn/v2/billing/meter/daily-checkin",
    origin: "https://www.codebuddy.cn",
    referer: "https://www.codebuddy.cn/",
    userAgent: "CLI/2.63.2 CodeBuddy/2.63.2"
  };
}

export class WorkBuddyProvider {
  constructor(config, env) {
    this.id = config.id || "workbuddy";
    this.name = config.name || "WorkBuddy";
    this.type = "workbuddy";
    this.env = env;
    this.config = config.config || {};
    // region 决定整组端点：默认 cn；配 config.region: "intl" 切国际站。
    // 构造永不抛错：intl 未实测前首次实际调用才报缺端点，避免一条未就绪配置拖垮整个网关。
    this.region = normalizeWorkbuddyRegion(this.config.region);
    this.endpoints = resolveWorkbuddyEndpoints(this.region);
    // 能力声明：上游非流式 JSON 可能是 200 业务错误包，调用方须强制 stream=true。
    // dispatch 经 contract.wantsStreamedChat 探针读取，不 switch type。
    this.forceStream = true;
  }

  get kv() {
    return this.env.GATEWAY_KV || this.env.WORKBUDDY_KV;
  }

  // 取可用端点表：intl 未实测时抛明确错误（而不是静默打错域名）。
  ep() {
    if (!this.endpoints?.probed) {
      throw new Error(
        `WorkBuddy provider "${this.id}" region "${this.region}" endpoints not probed yet — ` +
        `fill resolveWorkbuddyEndpoints() with measured intl paths first`
      );
    }
    return this.endpoints;
  }

  // 获取所有启用的账号列表（平级账号池，兼容无 accounts 数组的单账号扁平配置）
  getAccounts() {
    if (Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
      return this.config.accounts.filter(acc => acc.enabled !== false);
    }
    // intl 不得回退 env 凭证：env 里是 CN 账号，打到国际站必然鉴权失败，还会污染风控
    if (this.region === "intl") return [];
    // 降级兼顾单一账号配置
    const defaultUserId = this.config.userId || this.env.USER_ID;
    const defaultAccess = this.config.accessToken || this.env.ACCESS_TOKEN;
    const defaultRefresh = this.config.refreshToken || this.env.REFRESH_TOKEN;
    if (defaultUserId) {
      return [{
        id: "account-1",
        name: "Account 1",
        enabled: true,
        userId: defaultUserId,
        accessToken: defaultAccess,
        refreshToken: defaultRefresh,
        // 合成单账号标记：唯一允许借用 env 凭证的账号形态
        allowEnvFallback: true
      }];
    }
    return [];
  }

  // 获取特定账号的有效 Token（所有账号平级读取缓存；env 兜底仅合成单账号可用）
  async getActiveToken(account) {
    const cacheKey = `${this.id}_${account.id}`;
    const now = Date.now();
    const cached = memoryTokenCache.get(cacheKey);
    if (cached && (now - cached.timestamp < TOKEN_CACHE_TTL_MS)) {
      return cached.token;
    }

    if (this.kv) {
      const kvToken = await this.kv.get(`WB_ACCESS_TOKEN_${cacheKey}`) ||
                     (await this.kv.get(`WB_ACCESS_TOKEN_${this.id}`)) ||
                     (await this.kv.get("ACCESS_TOKEN"));
      if (kvToken) {
        memoryTokenCache.set(cacheKey, { token: kvToken, timestamp: now });
        return kvToken;
      }
    }

    const allowEnv = account.allowEnvFallback === true;
    const fallback = account.accessToken || (allowEnv ? this.env.ACCESS_TOKEN || "" : "");
    if (fallback) {
      memoryTokenCache.set(cacheKey, { token: fallback, timestamp: now });
    } else if (!allowEnv) {
      warnNoCredential(this.id, account);
    }
    return fallback;
  }

  // 刷新特定账号或全部账号的 AccessToken（所有账号平级刷新与存储）
  async refreshAccessToken(account = null) {
    if (!account) {
      const accounts = this.getAccounts();
      const results = await Promise.allSettled(accounts.map(acc => this.refreshAccessToken(acc)));
      return results.map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean);
    }
    const cacheKey = `${this.id}_${account.id}`;
    const allowEnv = account.allowEnvFallback === true;
    let refreshToken = account.refreshToken || (allowEnv ? this.env.REFRESH_TOKEN || "" : "");
    if (this.kv) {
      const cachedRefresh = await this.kv.get(`WB_REFRESH_TOKEN_${cacheKey}`) ||
                           (await this.kv.get(`WB_REFRESH_TOKEN_${this.id}`)) ||
                           (await this.kv.get("REFRESH_TOKEN"));
      if (cachedRefresh) refreshToken = cachedRefresh;
    }
    if (!refreshToken) {
      if (!allowEnv) warnNoCredential(this.id, account);
      return null;
    }

    try {
      const ep = this.ep();
      const resp = await fetch(ep.refresh, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "workbuddy",
          "User-Agent": ep.userAgent,
          "Origin": ep.origin,
          "Referer": ep.referer
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
          if (newRefresh) {
            await this.kv.put(`WB_REFRESH_TOKEN_${cacheKey}`, newRefresh);
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

  // 核心 Chat 接口：会话粘性 + 自动故障转移（Failover on 429 / Quota Error）。
  // 同一会话固定打同一健康账号（上游按账号隔离的前缀缓存保持热，命中率不随账号数稀释）；
  // 无会话标识时回退 round-robin；命中冷却/限流时 failover 照常漂移到下一健康账号。
  async callChat(payload, options = {}) {
    const allAccounts = this.getAccounts();
    if (allAccounts.length === 0) {
      return new Response(JSON.stringify({ error: { message: "No active WorkBuddy accounts configured" } }), { status: 500 });
    }

    // 先水合其他 isolate 写入的冷却记录，再做健康度筛选
    await hydrateCooldowns(this.env, allAccounts);

    // 账号排序委托给纯函数调度器：有粘性键时固定落点，无键时 round-robin，冷却账号按到期时间兜底
    const accounts = orderAccounts(
      allAccounts, accountCooldownRecord, Date.now(), roundRobinCounter,
      affinityKeyForCall(payload, options)
    );
    roundRobinCounter += 1;

    if (payload.messages) {
      payload.messages = sanitizeMessages(payload.messages);
    }

    const serializedPayload = JSON.stringify(payload);

    // 账号级故障转移收敛到 runFailover（见 src/core/failover.js）：循环、分类、耗尽收尾
    // 由驱动器统一处理；单个账号的“试一次”（401 刷新、抖动重试、业务码检测）见 attemptAccount。
    return await runFailover(accounts, {
      isAbort: (err) => err?.name === "AbortError",
      onRetryable: async (account, action, fail) => {
        const label = account.name || account.id;
        if (action === "retry") {
          // 5xx 服务端瞬时故障：切换下一账号，不惩罚当前账号
          console.warn(`[WorkBuddy] Account "${label}" returned ${fail.status}, auto-switching to next account...`);
          return;
        }
        // 429 / 403 / 额度 / 风控：惩罚性退避后切换下一账号
        console.warn(`[WorkBuddy] Account "${label}" quota/safety filter triggered (${fail.status}: ${String(fail.text).substring(0, 80)}), cooling down and auto-switching to next account...`);
        await setAccountCooldown(account, this.env, "cooldown");
      },
      renderExhausted: () => new Response(JSON.stringify({ error: { message: "All WorkBuddy accounts in pool failed" } }), { status: 502, headers: { "Content-Type": "application/json" } }),
      attempt: (account) => this.attemptAccount(account, payload, serializedPayload, options),
    });
  }

  // 对单个账号试一次（runFailover 的 attempt）：{ done } 命中即返；
  // { fail } 由驱动器分类后 fatal 即返 / cooldown-retry 切换；null 跳过该账号。
  async attemptAccount(account, payload, serializedPayload, options) {
    let token = await this.getActiveToken(account);
    const userId = account.userId;
    if (!token || !userId) return null;

    const makeRequest = async (tk) => {
      const ep = this.ep();
      const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "Connection": "keep-alive",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": ep.origin,
        "Referer": ep.referer,
        "User-Agent": ep.userAgent,
        "Authorization": `Bearer ${tk}`,
        "X-User-Id": userId,
        "X-Product": "SaaS"
      };
      return await fetch(ep.chat, {
        method: "POST",
        headers: headers,
        body: serializedPayload,
        signal: options.signal,
        keepalive: true
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
        } else {
          // 刷新失败：直接切换下一账号（不计入冷却 streak，401 通常是 token 过期而非额度问题）
          console.warn(`[WorkBuddy] Account "${account.name || account.id}" 401 token refresh failed, switching to next account...`);
          return null;
        }
      }

      // 遇到 502 / 503 / 504 服务端瞬时抖动，毫秒级原地快速重试一次（避开上游偶发拥塞）
      if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        console.warn(`[WorkBuddy] Account "${account.name || account.id}" hit ${resp.status}, retrying in 600ms...`);
        await new Promise(r => setTimeout(r, retryDelayMs(this.env)));
        if (options.signal?.aborted) {
          throw new DOMException("The operation was aborted", "AbortError");
        }
        const retryResp = await makeRequest(token);
        if (retryResp.ok) {
          await setAccountCooldown(account, this.env, "clear");
          return { done: new Response(retryResp.body, {
            status: retryResp.status,
            statusText: retryResp.statusText,
            headers: buildResponseHeaders(retryResp.headers, {
              "X-Gateway-Account": account.id || "account",
              "X-Gateway-Account-Id": account.id || "account"
            })
          }) };
        }
        resp = retryResp;
      }

      // 成功响应直接返回（若请求 stream 但返回 application/json，检测是否为腾讯 200 业务错误码）
      if (resp.ok) {
        const contentType = resp.headers.get("content-type") || "";
        if (payload.stream && contentType.includes("application/json")) {
          const clone = resp.clone();
          try {
            const resJson = await clone.json();
            if (businessErrorCode(resJson) !== 0) {
              // 200 包业务错误码：交驱动器分类（已知码 cooldown 惩罚并由 onRetryable 落盘，
              // 未知码 retry 只切换不惩罚）；预渲染响应在 fatal/耗尽时直接返回。
              return { fail: {
                status: 200,
                text: resJson.msg || resJson.message || JSON.stringify(resJson),
                json: resJson,
                response: new Response(JSON.stringify(resJson), {
                  status: 200,
                  headers: buildResponseHeaders(resp.headers, {
                    "Content-Type": "application/json",
                    "X-Gateway-Account": account.id || "account",
                    "X-Gateway-Account-Id": account.id || "account"
                  })
                })
              } };
            }
          } catch (e) {}
        }
        // 请求成功，清除冷却与连续惩罚标记
        await setAccountCooldown(account, this.env, "clear");
        return { done: new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: buildResponseHeaders(resp.headers, {
            "X-Gateway-Account": account.id || "account",
            "X-Gateway-Account-Id": account.id || "account"
          })
        }) };
      }

      const status = resp.status;

      // 失败收口：429 / 5xx / 403 / 额度耗尽等统一交驱动器分类
      //（fatal 即返预渲染响应，cooldown/retry 经 onRetryable 切换）。
      const errText = await resp.text();
      // 尝试解析 JSON 以进行结构化错误码判定
      let parsedJson = null;
      try { parsedJson = JSON.parse(errText); } catch (e) {}
      return { fail: {
        status,
        text: errText,
        json: parsedJson,
        response: new Response(errText, {
          status: status,
          headers: buildResponseHeaders(resp.headers, {
            "Content-Type": "application/json",
            "X-Gateway-Account": account.id || "account",
            "X-Gateway-Account-Id": account.id || "account"
          })
        })
      } };
    } catch (err) {
      if (err.name === "AbortError") {
        throw err; // 客户端主动中断取消，直接抛出终止
      }
      console.warn(`[WorkBuddy] Account "${account.name || account.id}" network error: ${err.message}, retrying in 600ms...`);
      try {
        await new Promise(r => setTimeout(r, retryDelayMs(this.env)));
        if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const retryResp = await makeRequest(token);
        if (retryResp.ok) return { done: retryResp };
        const retryErrText = await retryResp.text();
        let retryJson = null;
        try { retryJson = JSON.parse(retryErrText); } catch (e) {}
        return { fail: {
          status: retryResp.status,
          text: retryErrText,
          json: retryJson,
          response: new Response(retryErrText, {
            status: retryResp.status,
            headers: buildResponseHeaders(retryResp.headers, {
              "Content-Type": "application/json",
              "X-Gateway-Account": account.id || "account",
              "X-Gateway-Account-Id": account.id || "account"
            })
          })
        } };
      } catch (retryErr) {
        if (retryErr.name === "AbortError") throw retryErr;
        console.warn(`[WorkBuddy] Account "${account.name || account.id}" retry failed: ${retryErr.message}, switching next...`);
        return null;
      }
    }
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
        const ep = this.ep();
        const resp = await fetch(ep.billing, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "X-User-Id": userId,
            "User-Agent": ep.userAgent,
            "Origin": ep.origin,
            "Referer": ep.referer,
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
        let currentToken = token;
        const doReq = (tk) => fetch(this.ep().checkin, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${tk}`,
            "X-User-Id": userId,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": this.ep().userAgent,
            "Origin": this.ep().origin,
            "Referer": this.ep().referer
          },
          body: "{}"
        });

        let resp = await doReq(currentToken);
        if (resp.status === 401) {
          const refreshed = await this.refreshAccessToken(account);
          if (refreshed) {
            currentToken = refreshed;
            resp = await doReq(currentToken);
          }
        }

        const contentType = resp.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
          const text = await resp.text();
          return {
            id: account.id,
            name: account.name || account.id,
            success: false,
            error: `Upstream HTTP ${resp.status}: ${text.slice(0, 120).trim()}`
          };
        }

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
}
