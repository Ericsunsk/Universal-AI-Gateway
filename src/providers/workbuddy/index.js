import { sanitizeWorkbuddyPayload } from "./sanitize.js";
import { buildResponseHeaders } from "../../http/headers.js";
import { orderAccounts, businessErrorCode, hashString32 } from "../../core/scheduler.js";
import { runFailover, buildFail } from "../../core/failover.js";
import { redactUpstreamText, errorBody, upstreamErrorBody } from "../../http/redact.js";
import { accountCooldownRecord, hydrateCooldowns, setAccountCooldown } from "./cooldown.js";
import { log } from "../../logging/logger.js";

// 内存级多账号 Token 缓存字典: accountKey -> { token, timestamp }
const memoryTokenCache = new Map();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟热缓存
// 显式池成员缺凭证告警去重：每账号每进程只告警一次，避免热路径刷屏
const noCredentialWarned = new Set();
let roundRobinCounter = 0;

// 测试隔离钩：重置模块级调度计数器，让依赖账号顺序的用例确定性。
// 生产代码永不调用（复用 createMemoryKv 式的"测试拿隔离状态"思路）。
export function resetSchedulingCounterForTests() {
  roundRobinCounter = 0;
}

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
  log.warn("Account has no credentials, skipping (env fallback only applies to single-account config)", { account: account?.name || account?.id });
}

// 同一账号归因渲染 seam：所有上游透传响应的 X-Gateway-Account 收敛一处，
// 五处调用点不再手写归因头，避免漏标/错标漂移。
// 账号归因仅对 master 下发（options.principal?.isMaster），客户端 key 不暴露账号 ID。
function accountResponse(account, { body, status, statusText, headers, contentType }, exposeAccount = false) {
  return new Response(body, {
    status,
    statusText,
    headers: buildResponseHeaders(headers, {
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(exposeAccount ? { "X-Gateway-Account": account.id || "account" } : {})
    })
  });
}

// C2+C3：失败 fail 对象由 driver 拥有的 buildFail 构造（见 core/failover.js）：
// attempt 只交原始证据 {status,text,json} + 渲染 hint（headers/account），
// 预渲染 response 统一为 JSON 信封 {error:{message}}（C2），原文恰好脱敏一次。
// 直接调用 attemptAccount 的单测仍能看到 fail.response——构造器由 driver 模块拥有，
// 语义与 runFailover 内按需补齐的完全一致。
function failForAccount(account, evidence, exposeAccount) {
  return buildFail(evidence, (fail) => accountResponse(account, {
    body: upstreamErrorBody(String(fail.text ?? "")),
    status: fail.status,
    headers: fail.headers, contentType: "application/json"
  }, exposeAccount));
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
  } catch {}
  return null;
}

// Region 端点表：CN 现状冻结；intl 已实测（2026-09-14，见下）。
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
    // region 决定整组端点：默认 cn；配 config.region: "intl" 切国际站（两地均已实测）。
    this.region = normalizeWorkbuddyRegion(this.config.region);
    this.endpoints = resolveWorkbuddyEndpoints(this.region);
    // 能力声明：上游非流式 JSON 可能是 200 业务错误包，调用方须强制 stream=true。
    // dispatch 经 contract.wantsStreamedChat 探针读取，不 switch type。
    this.forceStream = true;
  }

  get kv() {
    return this.env.GATEWAY_KV || this.env.WORKBUDDY_KV;
  }

  // 取可用端点表（构造时已按 region 解析，恒可用）。
  ep() {
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
      log.error("Token refresh failed", { account: account.name || account.id, error: e?.message || String(e) });
    }
    return null;
  }

  // 401 自愈 seam：取 token → 请求 → 401 则清内存缓存、刷 token、重放一次。
  // 返回 { resp, token }（token 为 resp 实际使用的凭证）与 refreshed（是否发生过刷新）。
  // 刷新失败时 resp 仍是原始 401，调用方自行决定跳过还是继续——与旧 inline 语义一致。
  async doRequestWithRefresh(account, doRequest) {
    let token = await this.getActiveToken(account);
    let resp = await doRequest(token);
    if (resp.status !== 401) return { resp, token, refreshed: false };
    memoryTokenCache.delete(`${this.id}_${account.id}`);
    const refreshed = await this.refreshAccessToken(account);
    if (!refreshed) return { resp, token, refreshed: false };
    token = refreshed;
    return { resp: await doRequest(token), token, refreshed: true };
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

    // 针对腾讯上游 WAF 与渠道规则进行完整 Payload 规范化与脱敏（防 11128 unapproved channel）
    payload = sanitizeWorkbuddyPayload(payload);

    // 账号排序委托给纯函数调度器：有粘性键时固定落点，无键时 round-robin，冷却账号按到期时间兜底
    const accounts = orderAccounts(
      allAccounts, accountCooldownRecord, Date.now(), roundRobinCounter,
      affinityKeyForCall(payload, options)
    );
    roundRobinCounter += 1;

    const serializedPayload = JSON.stringify(payload);

    // 账号级故障转移收敛到 runFailover（见 src/core/failover.js）：循环、分类、retry 预算、
    // 耗尽收尾由驱动器统一处理；单账号的「一次往返 → 一个 outcome」见 attemptAccount。
    // 账号归因头仅对 master 下发；调用方经 options.principal 传入身份。
    const exposeAccount = options?.principal?.isMaster === true;
    return await runFailover(accounts, {
      isAbort: (err) => err?.name === "AbortError",
      retryBudget: 1,               // 每个账号允许一次原地重试（对齐旧“600ms 重试一次”）
      retryDelayMs: retryDelayMs(this.env),
      signal: options.signal,
      onRetryable: async (account, action, fail) => {
        const label = account.name || account.id;
        if (action === "retry") {
          // 5xx 服务端瞬时故障：切换下一账号，不惩罚当前账号
          log.warn("Account returned error, auto-switching to next account", { account: label, status: fail.status });
          return;
        }
        // 429 / 403 / 额度 / 风控：惩罚性退避后切换下一账号
        log.warn("Account quota/safety filter triggered, cooling down and auto-switching", { account: label, status: fail.status, text: redactUpstreamText(String(fail.text || "")).slice(0, 80) });
        await setAccountCooldown(account, this.env, "cooldown");
      },
      renderExhausted: () => new Response(errorBody("All WorkBuddy accounts in pool failed"), { status: 502, headers: { "Content-Type": "application/json" } }),
      // C3 backstop：若某条 attempt 交来无 response 的原始证据，driver 按本账号口径补齐
      // （与 failForAccount 同一信封；attemptAccount 直接返回的已预渲染 fail 保持原样）。
      renderFail: (fail, account) => accountResponse(account, {
        body: upstreamErrorBody(String(fail.text ?? "")),
        status: fail.status,
        headers: fail.headers, contentType: "application/json"
      }, exposeAccount),
      attempt: (account) => this.attemptAccount(account, payload, serializedPayload, options),
    });
  }

  // 单次尝试 = 一次「逻辑往返」→ 恰好一个 outcome（见 core/failover.js 的契约）。
  // 这里不再内嵌 sleep / 重试 / 跳过分支：5xx 与传输抖动都返回 { kind:"retry" }，
  // 由 driver 依据 retry 预算决定是否原地重发；缺 token 返回 { kind:"skip" }。
  // 401 刷新重放属于「同一次逻辑往返」的一部分，留在 doRequestWithRefresh 内。
  async attemptAccount(account, payload, serializedPayload, options) {
    const token = await this.getActiveToken(account);
    const userId = account.userId;
    if (!token || !userId) return { kind: "skip", reason: "missing-token-or-user" };

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

    const accountLabel = account.name || account.id;
    const delay = retryDelayMs(this.env);
    // 账号归因头仅对 master 下发；调用方经 options.principal 传入身份。
    const exposeAccount = options?.principal?.isMaster === true;

    // 单一映射点：把一次 resp 解释为恰好一个 outcome。5xx → retry，成功 → done，
    // 其余失败 → switch（交 driver 分类）。doRequestWithRefresh 已把 401 重放包在这一层内。
    // 分类所需的 JSON 解析不在调用方重复：只交原始 status + text，classifyFailure 自行解析。
    // fail 经 driver 拥有的 failForAccount 构造：原始证据 + 渲染 hint，response 为 C2 信封。
    const mapResponse = async (resp) => {
      // 502 / 503 / 504：服务端瞬时抖动，请求 driver 原地重试（预算与延迟归 driver）。
      if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        log.warn("Account returned error, requesting in-place retry", { account: accountLabel, status: resp.status });
        const errText = await resp.text();
        return { kind: "retry", delayMs: delay, fail: failForAccount(account, {
          status: resp.status,
          text: errText,
          headers: resp.headers,
        }, exposeAccount) };
      }

      if (resp.ok) {
        const contentType = resp.headers.get("content-type") || "";
        if (payload.stream && contentType.includes("application/json")) {
          const clone = resp.clone();
          try {
            const resJson = await clone.json();
            if (businessErrorCode(resJson) !== 0) {
              // 200 包业务错误码：这是 adapter 级判断（决定“200 其实是失败”），
              // 判定后把已解析的 json 作为证据交给驱动器分类（避免 classifyFailure 再解析一遍）。
              return { kind: "switch", fail: failForAccount(account, {
                status: 200,
                text: resJson.msg || resJson.message || JSON.stringify(resJson),
                json: resJson,
                headers: resp.headers,
              }, exposeAccount) };
            }
          } catch {}
        }
        await setAccountCooldown(account, this.env, "clear");
        return { kind: "done", response: accountResponse(account, {
          body: resp.body, status: resp.status,
          statusText: resp.statusText, headers: resp.headers
        }, exposeAccount) };
      }

      // 失败收口：429 / 403 / 额度耗尽 / 其余 4xx 统一交驱动器分类
      const status = resp.status;
      const errText = await resp.text();
      return { kind: "switch", fail: failForAccount(account, {
        status,
        text: errText,
        headers: resp.headers,
      }, exposeAccount) };
    };

    try {
      const { resp, refreshed } = await this.doRequestWithRefresh(account, makeRequest);
      if (resp.status === 401) {
        // 401 一律切换下一账号：刷新失败是 token 过期，刷新后仍 401 是凭证失效，
        // 都不计入冷却 streak，绝不 fatal 中断整池。
        log.warn("Account unauthorized, skipping", { account: accountLabel, after_refresh: !!refreshed });
        return { kind: "skip", reason: refreshed ? "auth-rejected-after-refresh" : "refresh-failed" };
      }
      return await mapResponse(resp);
    } catch (err) {
      if (err.name === "AbortError") throw err; // 客户端主动中断，直接抛出终止
      // 传输错误：请求 driver 原地重试（预算与延迟归 driver）。fail 留空——
      // driver 在预算耗尽时会以该异常作为权威错误收尾。
      log.warn("Account network error, requesting in-place retry", { account: accountLabel, error: err.message });
      return { kind: "retry", delayMs: delay, fail: null };
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
            const r = Math.max(
              parseFloat(acc.CapacityRemainPrecise || acc.CapacityRemain || 0),
              parseFloat(acc.CycleCapacityRemainPrecise || acc.CycleCapacityRemain || 0)
            );
            const s = Math.max(
              parseFloat(acc.CapacitySizePrecise || acc.CapacitySize || 0),
              parseFloat(acc.CycleCapacitySizePrecise || acc.CycleCapacitySize || 0)
            );
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
        log.error("Balance fetch error", { account: account.name, error: e?.message || String(e) });
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
        // 401 自愈一次（与 chat 路径同一 seam；失败则沿用原始响应继续判定）
        const { resp } = await this.doRequestWithRefresh(account, doReq);

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
