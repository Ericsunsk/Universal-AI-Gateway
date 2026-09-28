// WorkBuddy 上游 adapter —— 多账号池 + 会话粘性 + 自动故障转移（provider 编排层）。
// 账号轮转/冷却落 KV（见 ./cooldown.js），payload 清洗见 ./sanitize.js；
// 逐项尝试循环复用 core/failover.js 的唯一驱动器，凭证刷新见本文件 token 段。
import { sanitizeWorkbuddyPayload } from "./sanitize.js";
import { buildResponseHeaders, corsHeaders } from "../../http/headers.js";
import { orderAccounts, businessErrorCode, hashString32 } from "../../core/scheduler.js";
import { runFailover, buildFail } from "../../core/failover.js";
import { redactUpstreamText, errorBody, upstreamErrorBody } from "../../http/redact.js";
import { accountCooldownRecord, hydrateCooldowns, setAccountCooldown } from "./cooldown.js";
import { log } from "../../logging/logger.js";
import { outboundFetchInit } from "../urlGuard.js";

// 内存级多账号 Token 缓存字典: accountKey -> { token, timestamp }
const memoryTokenCache = new Map();
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟热缓存
// 在途刷新去重（singleflight）：cacheKey -> Promise。与 config.js 的 inflightConfigRefresh 同范式。
// 无此去重时，N 个并发请求同时撞上过期/401 会各自发一次 fetch(refresh) 并各写一轮 KV：
// 写放大的同时，后写者还会覆盖前者的 refreshToken/LAST_REFRESH，放大上游刷新侧的竞态。
let inflightTokenRefresh = new Map();
// 显式池成员缺凭证告警去重：每账号每进程只告警一次，避免热路径刷屏
const noCredentialWarned = new Set();
let roundRobinCounter = 0;

// 测试隔离钩：重置模块级调度计数器，让依赖账号顺序的用例确定性。
// 生产代码永不调用（复用 createMemoryKv 式的"测试拿隔离状态"思路）。
export function resetSchedulingCounterForTests() {
  roundRobinCounter = 0;
  inflightTokenRefresh = new Map();
  memoryTokenCache.clear();
}

// 抖动重试基准延迟（Q6 可配置）：env RETRY_BASE_MS，默认 600ms。
// Vercel 与 CF 超时/计费模型不同，允许两边设不同值；非法值回退默认。
export const DEFAULT_RETRY_DELAY_MS = 600;
export function retryDelayMs(env) {
  const raw = Number(env?.RETRY_BASE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.floor(raw);
}

// JWT 预过期静默刷新时间缓冲（默认 300 秒 = 5 分钟）：env JWT_REFRESH_BUFFER_SEC 可配置。
// 在 AccessToken 真正失效前 5 分钟由 getActiveToken 主动静默发起刷新，消除用户调用撞 401 的 1.5~2.5s 额外延迟。
export const DEFAULT_JWT_REFRESH_BUFFER_SEC = 300;
export function jwtRefreshBufferSec(env) {
  const raw = Number(env?.JWT_REFRESH_BUFFER_SEC);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_JWT_REFRESH_BUFFER_SEC;
  return Math.floor(raw);
}

/**
 * 从 JWT 格式 Token 中解析过期时间戳（UNIX epoch，秒）。
 * 若不是合法的 JWT 结构或缺失数值型 exp 字段，安全返回 null。
 */
export function parseJwtExp(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    let jsonStr;
    if (typeof Buffer !== "undefined") {
      jsonStr = Buffer.from(parts[1], "base64url").toString("utf8");
    } else {
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
      jsonStr = atob(padded);
    }
    const payload = JSON.parse(jsonStr);
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * 判定 JWT Token 是否已过期或即将过期（在 bufferSeconds 内）。
 * 若 Token 并非有效 JWT（如测试占位凭证），返回 false，不干扰非 JWT 凭证的既有逻辑。
 */
export function isJwtExpiringSoon(token, bufferSeconds = DEFAULT_JWT_REFRESH_BUFFER_SEC) {
  const exp = parseJwtExp(token);
  if (exp === null) return false;
  return (Date.now() / 1000) >= (exp - bufferSeconds);
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

// Tools Schema 序列化弱引用缓存：相同 tools 对象引用在多轮调用或并发计算中免除重复 JSON.stringify
const toolsSignatureCache = new WeakMap();

function serializeToolsForAffinity(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return "[]";
  const cached = toolsSignatureCache.get(tools);
  if (cached !== undefined) return cached;
  const str = JSON.stringify(tools);
  toolsSignatureCache.set(tools, str);
  return str;
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
    const sys = typeof first === "string" ? first : (first ? JSON.stringify(first) : "");
    const tools = serializeToolsForAffinity(payload?.tools);
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
    // 推理方言：WorkBuddy 上游拒收推理参数，须做方言清洗（见 core/contract.js）。
    // 显式声明而非依赖 type === "workbuddy" 兜底——新增上游不得隐式继承本方言。
    this.reasoningDialect = "workbuddy";
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

  // 获取特定账号的有效 Token（所有账号平级读取缓存；支持 JWT 预过期主动静默刷新；env 兜底仅合成单账号可用）
  async getActiveToken(account) {
    const cacheKey = `${this.id}_${account.id}`;
    const now = Date.now();
    const bufferSec = jwtRefreshBufferSec(this.env);

    // 1. 内存级热缓存检查
    const cached = memoryTokenCache.get(cacheKey);
    if (cached && (now - cached.timestamp < TOKEN_CACHE_TTL_MS)) {
      if (!isJwtExpiringSoon(cached.token, bufferSec)) {
        return cached.token;
      }
    }

    // 2. KV 持久缓存检查（优先原子凭据包，回落旧分键格式）
    let kvToken = null;
    if (this.kv) {
      const creds = await this.kv.get(`WB_CREDENTIALS_${cacheKey}`);
      if (creds) {
        try { kvToken = JSON.parse(creds)?.accessToken || null; }
        catch { /* 畸形 JSON 视为无缓存 */ }
      }
      if (!kvToken) {
        kvToken = await this.kv.get(`WB_ACCESS_TOKEN_${cacheKey}`);
      }
      if (kvToken && !isJwtExpiringSoon(kvToken, bufferSec)) {
        memoryTokenCache.set(cacheKey, { token: kvToken, timestamp: now });
        return kvToken;
      }
    }

    // 3. 初始静态配置 / 单账号 env 兜底
    const allowEnv = account.allowEnvFallback === true;
    const fallback = account.accessToken || (allowEnv ? this.env.ACCESS_TOKEN || "" : "");
    if (fallback && !isJwtExpiringSoon(fallback, bufferSec)) {
      memoryTokenCache.set(cacheKey, { token: fallback, timestamp: now });
      return fallback;
    }

    // 4. Token 临期 / 过期或未缓存：尝试通过 RefreshToken 主动静默预刷新（带 singleflight 去重）
    const refreshed = await this.refreshAccessToken(account);
    if (refreshed) {
      return refreshed;
    }

    // 5. 主动刷新未成功（网络抖动或无 refreshToken）：降级返回手头尚有的 token
    const bestEffort = cached?.token || kvToken || fallback;
    if (bestEffort) {
      memoryTokenCache.set(cacheKey, { token: bestEffort, timestamp: now });
      return bestEffort;
    }

    if (!allowEnv) {
      warnNoCredential(this.id, account);
    }
    return "";
  }

  // 刷新特定账号或全部账号的 AccessToken（所有账号平级刷新与存储）
  async refreshAccessToken(account = null) {
    if (!account) {
      const accounts = this.getAccounts();
      const results = await Promise.allSettled(accounts.map(acc => this.refreshAccessToken(acc)));
      return results.map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean);
    }
    // singleflight：同一账号的在途刷新只发一次网络往返，其余并发等待同一 promise。
    // 注意去重键含 this.id，避免不同 provider 实例的同名账号互相串用。
    const cacheKey = `${this.id}_${account.id}`;
    const existing = inflightTokenRefresh.get(cacheKey);
    if (existing) return existing;

    const task = this.refreshAccessTokenOnce(account, cacheKey)
      .finally(() => { inflightTokenRefresh.delete(cacheKey); });
    inflightTokenRefresh.set(cacheKey, task);
    return task;
  }

  // 单账号刷新的实际实现（不含去重）。仅由 refreshAccessToken 调用。
  async refreshAccessTokenOnce(account, cacheKey) {
    const allowEnv = account.allowEnvFallback === true;
    let refreshToken = account.refreshToken || (allowEnv ? this.env.REFRESH_TOKEN || "" : "");
    if (this.kv) {
      // 优先读原子凭据包（P0-2）；无则回落旧的分键格式（向后兼容既有部署）。
      const creds = await this.kv.get(`WB_CREDENTIALS_${cacheKey}`);
      if (creds) {
        try {
          const parsed = JSON.parse(creds);
          if (parsed?.refreshToken) refreshToken = parsed.refreshToken;
        } catch { /* 畸形 JSON 视为无凭据，回落 account/env */ }
      } else {
        const cachedRefresh = await this.kv.get(`WB_REFRESH_TOKEN_${cacheKey}`);
        if (cachedRefresh) refreshToken = cachedRefresh;
      }
    }
    if (!refreshToken) {
      if (!allowEnv) warnNoCredential(this.id, account);
      return null;
    }

    try {
      const ep = this.ep();
      const resp = await fetch(ep.refresh, {
        ...outboundFetchInit("workbuddy refresh"),
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
          // P0-2 修复：access/refresh 必须原子落盘。此前分两次独立 put，
          // 第二次失败会留下「新 accessToken + 已被上游消费的旧 refreshToken」，
          // 而 refreshAccessTokenOnce 优先读 KV → 账号永久失效且无自愈路径。
          // 现改为单条 JSON 一次 put，并保留旧键格式的读兼容（见 refreshAccessTokenOnce）。
          await this.kv.put(`WB_CREDENTIALS_${cacheKey}`, JSON.stringify({
            accessToken: newAccess,
            refreshToken: newRefresh || refreshToken,
            expiresAt: Date.now()
          }));
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
    // P0-3 修复：401 时必须同时清内存与 KV 的已失效 token。
    // 此前只清内存 → 下一次 getActiveToken 内存未命中后回落 KV，
    // 拿到已知 401 的旧 token 再打一次必然失败的请求，账号被封时上游调用 1→3。
    memoryTokenCache.delete(`${this.id}_${account.id}`);
    if (this.kv) {
      // 原子凭据包只失效 accessToken 字段、保留 refreshToken（否则会丢掉刷新能力）；
      // 旧分键格式则直接删除整个 access 键。
      const cacheKey = `${this.id}_${account.id}`;
      const creds = await this.kv.get(`WB_CREDENTIALS_${cacheKey}`);
      if (creds) {
        try {
          const parsed = JSON.parse(creds);
          parsed.accessToken = "";
          await this.kv.put(`WB_CREDENTIALS_${cacheKey}`, JSON.stringify(parsed));
        } catch { await this.kv.delete(`WB_CREDENTIALS_${cacheKey}`); }
      }
      // 无论走哪个分支都清一次 legacy 键：混合/部分迁移态的部署里，
      // 读取侧回退链可能命中残留的 stale WB_ACCESS_TOKEN_*，导致 401 循环。
      await this.kv.delete(`WB_ACCESS_TOKEN_${cacheKey}`);
    }
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
      return new Response(JSON.stringify({ error: { message: "No active WorkBuddy accounts configured" } }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
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
      renderExhausted: () => new Response(errorBody("All WorkBuddy accounts in pool failed"), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }),
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
        ...outboundFetchInit("workbuddy chat", { signal: options.signal }),
        method: "POST",
        headers: headers,
        body: serializedPayload,
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
          ...outboundFetchInit("workbuddy billing"),
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
          ...outboundFetchInit("workbuddy checkin"),
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
            error: redactUpstreamText(`Upstream HTTP ${resp.status}: ${text.slice(0, 120).trim()}`)
          };
        }

        const data = await resp.json();
        // 上游原文经脱敏后再外露：/checkin 回执含上游原始 JSON，可能夹带凭据/内网端点。
        // 此前直出（唯一未经 redact 的上游原文出口）——虽为 master/cron 鉴权，仍是泄露面。
        // 未被改动时保留原对象（避免无谓的序列化往返），有改动才回退为脱敏后的字符串。
        const rawJson = JSON.stringify(data);
        const safeJson = redactUpstreamText(rawJson);
        return {
          id: account.id,
          name: account.name || account.id,
          success: data.code === 0,
          result: safeJson === rawJson ? data : safeJson
        };
      } catch (e) {
        return { id: account.id, name: account.name, success: false, error: redactUpstreamText(e.message) };
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
