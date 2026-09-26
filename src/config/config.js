export const VERSION = "2.5.0";
import { log } from "../logging/logger.js";

let cachedConfig = null;
let cachedConfigTimestamp = 0;
const CONFIG_CACHE_TTL_MS = 60 * 1000; // 60 秒内存热缓存，彻底消除每请求访问 KV 的网络往返开销

// 解析 MAX_CONTEXT_TURNS：非负整数才有效，其余（NaN、负数、空、尾随杂质、布尔）一律 0（不剪枝）。
// 全网关唯一归一化口径（transform.js 复用此处，禁止另起 normalizeTurns 分叉）。
export function parseMaxContextTurns(raw) {
  if (raw === undefined || raw === null) return 0;
  // number 直接取；string trim 后 Number（"40abc"→NaN→0，严格拒绝尾随杂质）；
  // 其余类型（boolean/object/array）一律非法→0，避免 Number(true)===1 这类意外启用剪枝。
  let n;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return 0;
    n = Number(t);
  } else {
    return 0;
  }
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function requireSecret(env, name) {
  const value = env?.[name] || (typeof process !== "undefined" ? process.env?.[name] : undefined);
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Missing required secret "${name}". Refusing to fall back to a hardcoded default — ` +
      `set it in .env.local (local) or Vercel environment variables.`
    );
  }
  return value.trim();
}

export function getDefaultConfig(env) {
  // 拒绝硬编码兜底：缺失即抛错，避免默认主密钥等于公开字面量
  const defaultApiKey = requireSecret(env, "API_KEY");
  // MASTER_KEY 缺失即 fail-closed：随机生成并告警，绝不回退为 API_KEY
  //（回退会让所有客户端 key 拥有 master 权限）。
  let masterKey;
  if (env.MASTER_KEY) {
    masterKey = requireSecret(env, "MASTER_KEY");
  } else {
    masterKey = "unset-master-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    log.warn("MASTER_KEY is not set; generated an ephemeral value. Set MASTER_KEY to enable admin/cron endpoints");
  }
  // 国际站凭证同样走 secrets（与 CN 的 USER_ID 三件套同模式）；缺失即保持 disabled
  const readEnv = (name) => env?.[name] || (typeof process !== "undefined" ? process.env?.[name] : undefined);
  const intlUserId = readEnv("INTL_USER_ID") || "";

  return {
    config_version: 1,
    master_key: masterKey,
    cron_secret: env.CRON_SECRET || "",
    // NaN 护栏：非法值（如 "abc"）回退 0（不剪枝）。否则 NaN 会绕过 `<= 0` 的
    // “全量保真”分支、让 maxWindow/cutIdx 变成 NaN，静默裁掉整段历史。
    max_context_turns: parseMaxContextTurns(env.MAX_CONTEXT_TURNS),
    usage_provider_id: "workbuddy",
    // 纯透明直通管道：未声明的模型直接透传默认 provider（workbuddy），零硬编码模型映射
    default_provider: "workbuddy",
    providers: [
      {
        id: "workbuddy",
        name: "WorkBuddy (腾讯云代码助手)",
        type: "workbuddy",
        enabled: true,
        config: {
          accounts: [
            {
              id: "account-1",
              name: "Account 1",
              enabled: true,
              userId: env.USER_ID || "",
              accessToken: env.ACCESS_TOKEN || "",
              refreshToken: env.REFRESH_TOKEN || ""
            }
          ]
        }
      },
      {
        id: "workbuddy-intl",
        name: "WorkBuddy Intl (codebuddy.ai)",
        type: "workbuddy",
        enabled: intlUserId !== "",
        config: {
          region: "intl",
          accounts: intlUserId !== "" ? [{
            id: "intl-1",
            name: "Intl Account 1",
            enabled: true,
            userId: intlUserId,
            accessToken: readEnv("INTL_ACCESS_TOKEN") || "",
            refreshToken: readEnv("INTL_REFRESH_TOKEN") || ""
          }] : []
        }
      },
    ],
    routes: {},
    virtual_keys: {
      [defaultApiKey]: {
        name: "Default Client Key (CC-Switch / Claude Code)",
        enabled: true,
        models: ["*"],
        role: "client"
      }
    }
  };
}

// 纯函数：用代码默认路由回填 KV 存量配置里缺失的路由（只增不改）。
// 背景：KV 一旦写入就盖住代码默认，后续发版新增路由（如新的 workbuddy 模型路由）对存量环境不可见，
// 必须手动清 KV 才能生效。本函数让读路径自动补齐缺失项，各环境无需动线上密钥。
// 约束：只补“引用 provider 在存量配置里全部存在”的路由；空 provider 配置（如测试的降级场景）保持原样。
export function backfillMissingRoutes(stored, defaults) {
  if (!stored || typeof stored !== "object" || !defaults || typeof defaults !== "object") return stored;
  const storedRoutes = stored.routes;
  const defaultRoutes = defaults.routes;
  if (!storedRoutes || typeof storedRoutes !== "object" || Array.isArray(storedRoutes)) return stored;
  if (!defaultRoutes || typeof defaultRoutes !== "object" || Array.isArray(defaultRoutes)) return stored;
  const providerIds = new Set();
  eachProvider(stored.providers, (p) => { if (p?.id) providerIds.add(p.id); });
  let added = 0;
  for (const [model, routeList] of Object.entries(defaultRoutes)) {
    if (storedRoutes[model] !== undefined) continue;
    if (!Array.isArray(routeList) || routeList.length === 0) continue;
    if (!routeList.every((r) => r && typeof r.provider === "string" && providerIds.has(r.provider))) continue;
    storedRoutes[model] = JSON.parse(JSON.stringify(routeList));
    added++;
  }
  // 路由回填完成（生产环境已移除日志，避免启动噪音）
  if (added > 0 && process.env.DEBUG === "true") {
    log.info("Backfilled missing routes from code defaults", { added });
  }
  return stored;
}

// 在途刷新去重（singleflight）：缓存过期瞬间的突发只触发一次 KV 读，
// 其余并发等待同一 promise。forceRefresh 同样并入，避免测试与管理端并发刷新时重复打 KV。
let inflightConfigRefresh = null;

export async function getConfig(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && (now - cachedConfigTimestamp < CONFIG_CACHE_TTL_MS)) {
    return cachedConfig;
  }
  if (!inflightConfigRefresh) {
    inflightConfigRefresh = refreshConfig(env).finally(() => { inflightConfigRefresh = null; });
  }
  return inflightConfigRefresh;
}

async function refreshConfig(env) {
  const now = Date.now();
  const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
  // 区分“键不存在”与“远端读失败”的读状态；老 adapter / 测试无 getWithStatus 时降级为 get，
  // 此时 readOk 保持 true（无法感知失败，行为与旧代码一致）。
  let raw = null;
  let readOk = true;
  if (kv) {
    try {
      if (typeof kv.getWithStatus === "function") {
        const r = await kv.getWithStatus("GATEWAY_CONFIG");
        raw = r?.value ?? null;
        readOk = r?.ok !== false;
      } else {
        raw = await kv.get("GATEWAY_CONFIG");
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        const defaults = getDefaultConfig(env);
        // 存量 KV 可能落后于代码默认路由：内存中回填缺失项（不写 KV，无版本冲突）。
        try {
          backfillMissingRoutes(parsed, defaults);
        } catch (e) {
          log.warn("backfillMissingRoutes failed", { error: e?.message || String(e) });
        }
        // 环境变量兜底：master_key、cron_secret 与默认 API_KEY 永不因 KV 缺失或脱敏而失效
        if (!parsed.master_key) parsed.master_key = defaults.master_key;
        if (!parsed.cron_secret) parsed.cron_secret = defaults.cron_secret;
        if (!parsed.virtual_keys || typeof parsed.virtual_keys !== "object" || Array.isArray(parsed.virtual_keys) || Object.keys(parsed.virtual_keys).length === 0) {
          parsed.virtual_keys = defaults.virtual_keys;
        } else if (defaults.virtual_keys) {
          for (const [k, v] of Object.entries(defaults.virtual_keys)) {
            if (!parsed.virtual_keys[k]) parsed.virtual_keys[k] = v;
          }
        }
        cachedConfig = parsed;
        cachedConfigTimestamp = now;
        return parsed;
      }
    } catch (e) {
      // 读抛错（而非显式返回 ok=false）也必须视为“读失败”，否则 readOk 仍为 true，
      // 会落到下方初始配置写入分支，用默认模板 clobber 远端真实存量配置。
      readOk = false;
      log.error("Failed to read GATEWAY_CONFIG from KV", { error: e?.message || String(e) });
    }

    // 读失败（显式 ok=false，或上面 catch 里的抛错）：绝不能当作“无配置”，
    // 否则会用默认模板覆盖远端真实存量配置（写放大即数据丢失）。此处只读不写。
    if (!readOk) {
      log.error("GATEWAY_CONFIG remote read failed; refusing to regenerate/write initial config");
      // 有真实缓存则优先复用（陈旧但真实 > 默认值覆盖远端）；否则退默认但绝不写 KV。
      const fallback = cachedConfig || getDefaultConfig(env);
      // 失败回退用短 TTL（10s），成功才用 60s：KV 抖动恢复后快速自愈，
      // 而不是污染缓存整整一个 TTL 窗口。
      cachedConfig = fallback;
      cachedConfigTimestamp = now - (CONFIG_CACHE_TTL_MS - 10 * 1000);
      return fallback;
    }
  }

  // 初始配置：从默认模板生成并初次写入 KV（仅“确认真实首启”即 raw 缺失且读成功时）
  const initialConfig = getDefaultConfig(env);
  if (kv) {
    try {
      // 冷启动双写护栏：写前重读一次，若已有配置则放弃写入，
      // 避免并发冷启动以后写者覆盖先到的管理员编辑（KV 无 NX 语义下的最佳努力）。
      let stillEmpty = (raw === null);
      if (stillEmpty && typeof kv.get === "function") {
        try {
          const recheck = await kv.get("GATEWAY_CONFIG");
          stillEmpty = (recheck === null || recheck === undefined);
        } catch {
          log.warn("Pre-write recheck failed; skipping initial write to avoid clobbering");
          stillEmpty = false;
        }
      }
      if (stillEmpty) {
        await kv.put("GATEWAY_CONFIG", JSON.stringify(initialConfig, null, 2));
      }
    } catch (e) {
      log.warn("Failed to write initial GATEWAY_CONFIG", { error: e?.message || String(e) });
    }
  }

  cachedConfig = initialConfig;
  cachedConfigTimestamp = now;
  return initialConfig;
}


// 遍历 providers 集合，兼容数组与对象两种形态
function eachProvider(providers, fn) {
  if (!providers) return;
  if (Array.isArray(providers)) providers.forEach(fn);
  else if (typeof providers === "object") Object.values(providers).forEach(fn);
}




