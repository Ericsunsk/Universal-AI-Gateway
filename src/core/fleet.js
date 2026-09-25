import { createProvider } from "../providers/index.js";
import { hasGetBalance, hasDailyCheckin, hasTokenRefresh } from "./contract.js";
import { log } from "../logging/logger.js";

let cachedFleet = null;

// 余额短缓存：providerId -> { at, value }（进程级，与 cachedFleet 同生命周期语义）
const balanceCache = new Map();
const BALANCE_TTL_MS = 60 * 1000;
const BALANCE_ERROR_TTL_MS = 10 * 1000;
// 模块单例不随 fleet 重建清空，须自带上界防止换血/脏 providerId 无限膨胀；
// 采用 Map 插入序做 LRU（与 src/kv/index.js createMemoryKv 同款），100 远超实际 provider 数。
const BALANCE_CACHE_MAX_ENTRIES = 100;

function cacheBalance(providerId, entry) {
  if (!balanceCache.has(providerId) && balanceCache.size >= BALANCE_CACHE_MAX_ENTRIES) {
    // Map 按插入有序，删最旧一条
    balanceCache.delete(balanceCache.keys().next().value);
  }
  // 重复写入移到队尾，保持 LRU 语义
  balanceCache.delete(providerId);
  balanceCache.set(providerId, entry);
}

export class ProviderFleet {
  constructor(config, env) {
    this.config = config;
    this.env = env;
    this._instances = new Map();

    const providerConfigs = config.providers || [];
    for (const pConf of providerConfigs) {
      if (pConf.enabled !== false) {
        try {
          const instance = createProvider(pConf, env);
          if (instance) {
            this._instances.set(pConf.id, instance);
          }
        } catch (e) {
          log.warn("Skipping unavailable provider", { provider: pConf?.id, error: e.message });
        }
      }
    }
  }

  getProvider(id) {
    return this._instances.get(id) || null;
  }

  getAllActive() {
    return Array.from(this._instances.values());
  }

  get activeCount() {
    return this._instances.size;
  }

  // 统一余额查询（短 TTL 缓存：/v1/usage 被 CC-Switch 高频轮询，
  // 每次都打上游等于拿用户配额做心跳。成功 60s / 失败 10s；仅展示用途，路由与鉴权不受影响）
  // 归属注意：balanceCache 是模块单例，不随 config_version 重建 fleet 而清空 ——
  // provider 换血后余额最多陈旧一个 TTL 窗口，换来零额外 KV/上游开销。
  async getBalance(targetId = null) {
    const providerId = targetId || this.config.usage_provider_id || "workbuddy";
    const now = Date.now();
    const hit = balanceCache.get(providerId);
    if (hit && now - hit.at < (hit.value.success ? BALANCE_TTL_MS : BALANCE_ERROR_TTL_MS)) {
      // 命中刷新 LRU 位序：否则热 key 因插入早、会被新 ID 洪水逐出（真 LRU 语义）
      balanceCache.delete(providerId);
      balanceCache.set(providerId, hit);
      return hit.value;
    }
    const provider = this.getProvider(providerId);
    if (!provider || !hasGetBalance(provider)) {
      return { success: false, balance: 0, total: 0, unit: "积分" };
    }
    try {
      const res = await provider.getBalance();
      // 余额形态归一：无数值 balance（如 openai 的 {success,data}）视为不支持，
      // success:false 而非静默 balance:0 + success:true。
      if (res?.success === true && typeof res.balance !== "number") {
        const value = { success: false, balance: 0, total: 0, unit: res.unit || "积分", error: "Upstream balance not available" };
        cacheBalance(providerId, { at: now, value });
        return value;
      }
      const value = {
        success: !!res.success,
        balance: res.balance ?? 0,
        total: res.total ?? 0,
        unit: res.unit || "积分",
        accounts_count: res.accounts_count || 1,
        accounts: res.accounts || []
      };
      cacheBalance(providerId, { at: now, value });
      return value;
    } catch (e) {
      const value = { success: false, balance: 0, total: 0, unit: "积分", error: e.message };
      cacheBalance(providerId, { at: now, value });
      return value;
    }
  }

  // 批量执行签到
  async runDailyCheckins() {
    const results = [];
    for (const provider of this.getAllActive()) {
      if (hasDailyCheckin(provider)) {
        try {
          const res = await provider.doDailyCheckin();
          results.push({ provider: provider.id, res });
        } catch (e) {
          results.push({ provider: provider.id, error: e.message });
        }
      }
    }
    return results;
  }

  // 批量刷新 Token
  async refreshAllTokens() {
    const results = [];
    for (const provider of this.getAllActive()) {
      if (hasTokenRefresh(provider)) {
        try {
          const res = await provider.refreshAccessToken();
          const refreshed = Array.isArray(res) ? res.length > 0 : !!res;
          results.push({ provider: provider.id, refreshed, count: Array.isArray(res) ? res.length : 1 });
        } catch (e) {
          results.push({ provider: provider.id, error: e.message });
        }
      }
    }
    return results;
  }
}

// FleetConfig：重建规则的显式值对象（C4）。
// ProviderFleet 消费的全部输入收敛一处：providers 全量快照（不再维护字段 allowlist——
// baseUrl/apiKey/balanceUrl/账号 token 等凭据漂移同样触发重建）+ usage_provider_id
//（getBalance 默认目标）+ config_version + env 身份 + 原引用。
// 比较规则收敛在 fleetConfigEquals 内；调用方仍只传 (config, env)，签名不变。
function sortCloneForFleet(value) {
  if (Array.isArray(value)) return value.map(sortCloneForFleet);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      out[k] = sortCloneForFleet(v);
    }
    return out;
  }
  return value;
}

function providersFingerprint(config) {
  try {
    const raw = config?.providers;
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    // 全量快照 + 键序归一：语义相同（仅键序不同）不重建；任意值漂移（含凭据）必重建。
    return JSON.stringify(sortCloneForFleet({
      providers: list,
      usage_provider_id: config?.usage_provider_id ?? null,
    }));
  } catch {
    return "";
  }
}

export function toFleetConfig(config, env) {
  return {
    version: config?.config_version,
    hash: providersFingerprint(config),
    env,
    ref: config,
  };
}

// 重建规则唯一实现：env 身份轮换必重建（避免 provider 持有旧 env/KV 绑定）；
// 有版本号时比 version+指纹（人工 bump 易忘，指纹兜底只加 provider 的场景）；
// 无版本号时回退引用判等（与旧语义一致）。
// 注意：KV 直行写入配置时仍建议 bump config_version。
export function fleetConfigEquals(prev, next) {
  if (!prev || !next) return false;
  if (prev.env !== next.env) return false;
  if (next.version !== undefined) {
    return prev.version === next.version && prev.hash === next.hash;
  }
  return prev.ref === next.ref;
}

let cachedFleetConfig = null;
export function getProviderFleet(config, env) {
  const next = toFleetConfig(config, env);
  if (cachedFleet && cachedFleetConfig && fleetConfigEquals(cachedFleetConfig, next)) {
    return cachedFleet;
  }
  cachedFleet = new ProviderFleet(config, env);
  cachedFleetConfig = next;
  return cachedFleet;
}
