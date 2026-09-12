import { createProvider } from "./index.js";

let cachedFleet = null;
let cachedFleetConfigRef = null;

export class ProviderFleet {
  constructor(config, env) {
    this.config = config;
    this.env = env;
    this._instances = new Map();

    const providerConfigs = config.providers || [];
    for (const pConf of providerConfigs) {
      if (pConf.enabled !== false) {
        const instance = createProvider(pConf, env);
        if (instance) {
          this._instances.set(pConf.id, instance);
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

  // 统一余额查询
  async getBalance(targetId = null) {
    const providerId = targetId || this.config.usage_provider_id || "workbuddy";
    const provider = this.getProvider(providerId);
    if (!provider || typeof provider.getBalance !== "function") {
      return { success: false, balance: 0, total: 0, unit: "积分" };
    }
    try {
      const res = await provider.getBalance();
      return {
        success: !!res.success,
        balance: res.balance ?? 0,
        total: res.total ?? 0,
        unit: res.unit || "积分",
        accounts_count: res.accounts_count || 1,
        accounts: res.accounts || []
      };
    } catch (e) {
      return { success: false, balance: 0, total: 0, unit: "积分", error: e.message };
    }
  }

  // 批量触发 Cron 定时调度（保活与签到）
  async runScheduledTasks() {
    const tasks = [];
    for (const provider of this.getAllActive()) {
      if (typeof provider.onSchedule === "function") {
        tasks.push(provider.onSchedule().catch(err => console.error(`[Fleet] Scheduled task failed for ${provider.id}:`, err)));
      }
    }
    await Promise.allSettled(tasks);
  }

  // 批量执行签到
  async runDailyCheckins() {
    const results = [];
    for (const provider of this.getAllActive()) {
      if (typeof provider.doDailyCheckin === "function") {
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
      if (typeof provider.refreshAccessToken === "function") {
        try {
          const token = await provider.refreshAccessToken();
          results.push({ provider: provider.id, refreshed: !!token });
        } catch (e) {
          results.push({ provider: provider.id, error: e.message });
        }
      }
    }
    return results;
  }
}

// 单例获取 Fleet，复用 Provider 实例减少无谓的对象重新分配
export function getProviderFleet(config, env) {
  if (cachedFleet && cachedFleetConfigRef === config) {
    return cachedFleet;
  }
  cachedFleet = new ProviderFleet(config, env);
  cachedFleetConfigRef = config;
  return cachedFleet;
}
