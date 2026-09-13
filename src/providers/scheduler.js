// AccountScheduler —— 纯函数调度器：把「多账号选择、指数退避、错误分类」从
// callChat 的 I/O 纠缠中剥离出来。这里没有任何 env / KV / fetch / 全局变量：
// 冷却状态由调用方传入（cooldownMap）并显式传回，便于单元测试与推理。
//
// 术语：
//   account      —— 一个可调度的账号 { id, name?, ... }
//   cooldownMap  —— Map<accountId, { expiresAt:number, streak:number }>
//   cooldown     —— 冷却中（已退避，暂时跳过）
//   retry        —— 切换下一个账号（服务端瞬时故障，不惩罚）
//   fatal        —— 不可恢复，直接返回错误给客户端

// 指数退避上限（分钟）
export const BACKOFF_MAX_MINUTES = 8;
// 首次退避分钟数（streak 从 1 开始）
export const BACKOFF_BASE_MINUTES = 1;

// 计算某 streak 下的退避时长（分钟）：1 -> 2 -> 4 -> 8（封顶）
export function backoffMinutesForStreak(streak) {
  const safe = Math.max(0, Math.floor(streak));
  return Math.min(Math.pow(2, safe - 1), BACKOFF_MAX_MINUTES);
}

// 纯函数：给定账号与冷却状态，计算「下一次应尝试的账号」的有序数组。
// 健康账号按 round-robin 轮转；无健康账号时按冷却到期时间升序兜底。
// 返回新数组，不修改入参。
export function orderAccounts(accounts, cooldownMap, now = Date.now(), rrIndex = 0) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];

  const healthy = accounts.filter(acc => {
    const rec = cooldownMap.get(acc.id);
    return !rec || rec.expiresAt < now;
  });
  const cooling = accounts.filter(acc => {
    const rec = cooldownMap.get(acc.id);
    return rec && rec.expiresAt >= now;
  });

  if (healthy.length > 0) {
    const startIdx = ((rrIndex % healthy.length) + healthy.length) % healthy.length;
    return [
      ...healthy.slice(startIdx),
      ...healthy.slice(0, startIdx),
      ...cooling
    ];
  }

  // 全部冷却：按到期时间升序（最早可用的排前面）
  cooling.sort((a, b) => {
    const tA = cooldownMap.get(a.id)?.expiresAt || 0;
    const tB = cooldownMap.get(b.id)?.expiresAt || 0;
    return tA - tB;
  });
  return cooling.length > 0 ? cooling : accounts;
}

// 纯函数：对账号施加一次指数退避，返回新的冷却记录（不修改 map）。
// streak 递增，expiresAt 按 2^(streak-1) 分钟封顶 8 分钟推进。
export function computeCooldown(accountId, cooldownMap, now = Date.now()) {
  const current = cooldownMap.get(accountId) || { expiresAt: 0, streak: 0 };
  const streak = current.streak + 1;
  const backoffMinutes = backoffMinutesForStreak(streak);
  const expiresAt = now + backoffMinutes * 60 * 1000;
  return { expiresAt, streak };
}

// 纯函数：将 HTTP 状态码 + 响应体分类为调度动作。
//   "cooldown" —— 惩罚性退避（429 / 403 / 结构化业务错误码 / 额度耗尽 / 风控）
//   "retry"    —— 切换下一账号但不惩罚（5xx 服务端瞬时故障）
//   "fatal"    —— 不可恢复的客户端错误，直接返回
//
// 优先使用结构化业务错误码判定（如腾讯 11140/11128/6004），
// 仅在 code 字段不存在时，才回退到文本关键词匹配。
// 这防止普通对话内容（如 "my quota is low"）误判为账号冷却。
export function classify(status, bodyText = "", resJson = null) {
  const text = (bodyText || "").toLowerCase();

  // 1. 结构化错误码优先：从 200 JSON 响应中读取业务 code（通过 businessErrorCode）
  //    这样可以避免在 200 响应体里的自由文本里误匹配 "quota"/"rate limit" 等关键词
  if (resJson) {
    const bizCode = businessErrorCode(resJson);
    if (bizCode !== 0) {
      // 已知惩罚性业务码 → cooldown（额度/风控/限流）
      if (bizCode === 11140 || bizCode === 11128 || bizCode === 6004) {
        return "cooldown";
      }
      if (bizCode === 429 || bizCode === 403) {
        return "cooldown";
      }
      // 未知业务码 → retry（切换下一账号，但不惩罚）。
      // previously 一律 cooldown 会把客户端参数错误等计入惩罚 streak，污染退避状态；
      // 但直接 fatal 又会在码实为账号级额度时丢掉可用性。未知 = 不惩罚 + 照常切换。
      return "retry";
    }
  }

  // 2. 状态码直接判定
  if (status === 429) return "cooldown";
  if (status >= 500) return "retry";

  // 3. 仅在没有结构化码时，才使用文本关键词兜底
  // 关键词表是全网关唯一的“可故障转移”定义（workbuddy 账号切换与 exchange 路由切换共用），
  // 新增上游错误特征只改这里，不要在调用方另起一份内联表。
  if (
    status === 403 ||
    text.includes("11140") ||
    text.includes("11128") ||
    text.includes("14018") ||
    text.includes("6004") ||
    text.includes("quota") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("overloaded") ||
    text.includes("service unavailable") ||
    text.includes("endpoint is unavailable") ||
    text.includes("freeusagelimiterror") ||
    text.includes("频率限制") ||
    text.includes("欠费") ||
    text.includes("余额不足") ||
    text.includes("安全审核")
  ) {
    return "cooldown";
  }

  return "fatal";
}

// 纯函数：判断腾讯在 200 状态里返回的业务错误码是否应触发退避。
// 返回 0 表示无业务错误；否则返回业务错误码。
export function businessErrorCode(resJson) {
  if (resJson && typeof resJson === "object" && resJson.code !== undefined && resJson.code !== 0) {
    return resJson.code;
  }
  return 0;
}
