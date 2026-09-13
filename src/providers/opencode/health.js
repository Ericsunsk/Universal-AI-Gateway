// 模型健康追踪 —— 429 熔断、冷却与延迟评分，callChat 与 callResponsesApi 共用单例。
/**
 * 免费模型健康度与延迟监控追踪器
 * 记录连续 429 熔断、冷却时间和平均首字延迟 (TTFB)
 */
export class ModelHealthTracker {
  constructor() {
    this.stats = new Map();
  }

  getOrCreate(model) {
    if (!this.stats.has(model)) {
      this.stats.set(model, {
        streak429: 0,
        cooldownUntil: 0,
        avgLatencyMs: 300,
        callCount: 0,
        successCount: 0
      });
    }
    return this.stats.get(model);
  }

  recordSuccess(model, latencyMs) {
    const entry = this.getOrCreate(model);
    entry.streak429 = 0;
    entry.cooldownUntil = 0;
    entry.avgLatencyMs = entry.callCount === 0
      ? latencyMs
      : Math.round(entry.avgLatencyMs * 0.7 + latencyMs * 0.3);
    entry.callCount++;
    entry.successCount++;
  }

  recordFailure(model, status, isRateLimit = false) {
    const entry = this.getOrCreate(model);
    entry.callCount++;
    if (isRateLimit || status === 429) {
      entry.streak429 = (entry.streak429 || 0) + 1;
      const backoffSec = Math.min(300, 30 * Math.pow(2, entry.streak429 - 1));
      entry.cooldownUntil = Date.now() + backoffSec * 1000;
    }
  }

  isCooling(model) {
    const entry = this.stats.get(model);
    return Boolean(entry && entry.cooldownUntil > Date.now());
  }

  getScore(model) {
    const entry = this.stats.get(model);
    if (!entry) return 1000;
    if (entry.cooldownUntil > Date.now()) {
      return -10000 - (entry.cooldownUntil - Date.now());
    }
    const latencyPenalty = Math.min(600, Math.round((entry.avgLatencyMs || 300) / 2));
    return 1000 - latencyPenalty;
  }

  sortModels(models) {
    return [...models].sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  getSummary() {
    const summary = {};
    for (const [model, stat] of this.stats.entries()) {
      summary[model] = {
        latency: `${stat.avgLatencyMs}ms`,
        cooling: stat.cooldownUntil > Date.now(),
        cooldownRemainingSec: Math.max(0, Math.round((stat.cooldownUntil - Date.now()) / 1000)),
        successRate: stat.callCount > 0 ? `${Math.round((stat.successCount / stat.callCount) * 100)}%` : "N/A"
      };
    }
    return summary;
  }
}

export const globalOpenCodeHealthTracker = new ModelHealthTracker();
