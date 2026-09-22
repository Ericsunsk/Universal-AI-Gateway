import { createProvider } from "../providers/index.js";
import { hasGetBalance, hasDailyCheckin, hasTokenRefresh } from "./contract.js";

let cachedFleet = null;
let cachedFleetConfigRef = null;
let cachedFleetVersion = undefined;

// 余额短缓存：providerId -> { at, value }（进程级，与 cachedFleet 同生命周期语义）
const balanceCache = new Map();
const BALANCE_TTL_MS = 60 * 1000;
const BALANCE_ERROR_TTL_MS = 10 * 1000;

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

  // 统一余额查询（短 TTL 缓存：/v1/usage 被 CC-Switch 高频轮询，/admin/api/status 被控制台轮询，
  // 每次都打上游等于拿用户配额做心跳。成功 60s / 失败 10s；仅展示用途，路由与鉴权不受影响）
  async getBalance(targetId = null) {
    const providerId = targetId || this.config.usage_provider_id || "workbuddy";
    const now = Date.now();
    const hit = balanceCache.get(providerId);
    if (hit && now - hit.at < (hit.value.success ? BALANCE_TTL_MS : BALANCE_ERROR_TTL_MS)) {
      return hit.value;
    }
    const provider = this.getProvider(providerId);
    if (!provider || !hasGetBalance(provider)) {
      return { success: false, balance: 0, total: 0, unit: "积分" };
    }
    try {
      const res = await provider.getBalance();
      const value = {
        success: !!res.success,
        balance: res.balance ?? 0,
        total: res.total ?? 0,
        unit: res.unit || "积分",
        accounts_count: res.accounts_count || 1,
        accounts: res.accounts || []
      };
      balanceCache.set(providerId, { at: now, value });
      return value;
    } catch (e) {
      const value = { success: false, balance: 0, total: 0, unit: "积分", error: e.message };
      balanceCache.set(providerId, { at: now, value });
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
// 判等优先用 config_version：getConfig 每 60s 刷新会产生新对象（内容不变），
// 按引用判等会导致 provider 实例每分钟重建一次（含各 adapter 构造开销）。
// saveConfig 每次写入必 bump 版本，所以版本号相等即配置未变；无版本号时回退引用判等。
export function getProviderFleet(config, env) {
  const version = config?.config_version;
  const same = cachedFleet && (version !== undefined
    ? cachedFleetVersion === version
    : cachedFleetConfigRef === config);
  if (same) {
    return cachedFleet;
  }
  cachedFleet = new ProviderFleet(config, env);
  cachedFleetConfigRef = config;
  cachedFleetVersion = version;
  return cachedFleet;
}
