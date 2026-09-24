import { createProvider } from "../providers/index.js";
import { hasGetBalance, hasDailyCheckin, hasTokenRefresh } from "./contract.js";

let cachedFleet = null;
let cachedFleetConfigRef = null;
let cachedFleetVersion = undefined;

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
          console.warn(`[Fleet] Skipping unavailable provider "${pConf?.id}": ${e.message}`);
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

// 单例获取 Fleet，复用 Provider 实例减少无谓的对象重新分配。
// 判等优先用 config_version，但版本号是人工 bump、易忘：同时比对 providers 指纹
//（id/type/enabled/region+账号结构），只加 provider 不 bump 时也能重建；
// env 身份轮换（KV 绑定变化）同样触发重建，避免 provider 持有旧 env。
// 注意：KV 直行写入配置时仍建议 bump config_version；无版本号时回退引用判等。
function providersFingerprint(config) {
  try {
    const list = Array.isArray(config?.providers) ? config.providers : Object.values(config?.providers || {});
    return JSON.stringify(list.map((p) => ({
      id: p?.id, type: p?.type, enabled: p?.enabled,
      region: p?.config?.region,
      accounts: (p?.config?.accounts || []).map((a) => ({ id: a?.id, enabled: a?.enabled, userId: a?.userId }))
    })));
  } catch (e) {
    return "";
  }
}
let cachedFleetProvidersHash = "";
let cachedFleetEnv = null;
export function getProviderFleet(config, env) {
  const version = config?.config_version;
  const hash = providersFingerprint(config);
  const same = cachedFleet && (version !== undefined
    ? (cachedFleetVersion === version && cachedFleetProvidersHash === hash && cachedFleetEnv === env)
    : (cachedFleetConfigRef === config && cachedFleetEnv === env));
  if (same) {
    return cachedFleet;
  }
  cachedFleet = new ProviderFleet(config, env);
  cachedFleetConfigRef = config;
  cachedFleetVersion = version;
  cachedFleetProvidersHash = hash;
  cachedFleetEnv = env;
  return cachedFleet;
}
