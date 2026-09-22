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
const BACKOFF_MAX_MINUTES = 8;

// 计算某 streak 下的退避时长（分钟）：1 -> 2 -> 4 -> 8（封顶）
export function backoffMinutesForStreak(streak) {
  const safe = Math.max(0, Math.floor(streak));
  return Math.min(Math.pow(2, safe - 1), BACKOFF_MAX_MINUTES);
}

// 纯函数：32 位 FNV-1a 哈希（会话粘性键 → 确定性下标；集中在此一处，避免各处手写哈希分叉）。
export function hashString32(str) {
  const s = String(str ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 纯函数：会话粘性起始位 —— 同一 key 永远映射到同一健康账号下标，
// 让上游按账号隔离的前缀缓存保持热。只在健康子集内取值，冷却账号不参与。
export function affinityStartIndex(key, healthyCount) {
  if (!key || !Number.isFinite(healthyCount) || healthyCount <= 0) return 0;
  return hashString32(key) % healthyCount;
}

// 纯函数：给定账号与冷却状态，计算「下一次应尝试的账号」的有序数组。
// 有 affinityKey 时健康账号按会话粘性落点（同一会话固定账号，上游缓存保持热）；
// 无 key 时按 round-robin 轮转（旧语义不变）。无健康账号时按冷却到期时间升序兜底。
// 返回新数组，不修改入参。
export function orderAccounts(accounts, cooldownMap, now = Date.now(), rrIndex = 0, affinityKey = null) {
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
    const startIdx = affinityKey != null
      ? affinityStartIndex(affinityKey, healthy.length)
      : (((rrIndex % healthy.length) + healthy.length) % healthy.length);
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

// WAF / 滑块验证码特征（T6 决议，T2 画像）：命中即惩罚性退避。
// 与普通关键词不同——这些签名只出现在风控挑战页里，不会出现在正常对话内容中，
// 所以放在最前：即使状态码是 400/404（挑战页常套正常码）也必须冷却漂移，不能当 fatal 直接返回。
const WAF_BODY_MARKERS = [
  "fail_sys_user_validate",
  "rgv587_error",
  "_____tmd_____/punish",
  "x5secdata",
  "aliyun_waf",
  "nc-no-captcha",
  "滑块",
  "真人验证",
  "访问验证"
];

// 纯函数：响应体是否为 WAF / 验证码挑战（非真实业务响应）。
export function isWAFChallenge(bodyText = "") {
  const text = String(bodyText || "").toLowerCase();
  if (!text) return false;
  return WAF_BODY_MARKERS.some(m => text.includes(m));
}

// 纯函数：将 HTTP 状态码 + 响应体分类为调度动作。
//   "cooldown" —— 惩罚性退避（429 / 403 / 结构化业务错误码 / 额度耗尽 / 风控 / WAF 挑战）
//   "retry"    —— 切换下一账号但不惩罚（5xx 服务端瞬时故障）
//   "fatal"    —— 不可恢复的客户端错误，直接返回
//
// 优先使用结构化业务错误码判定（如腾讯 11140/11128/6004），
// 仅在 code 字段不存在时，才回退到文本关键词匹配。
// 这防止普通对话内容（如 "my quota is low"）误判为账号冷却。
export function classify(status, bodyText = "", resJson = null) {
  const text = (bodyText || "").toLowerCase();

  // 0. WAF 挑战优先：签名只出现在风控页，不可能误伤正常对话
  if (isWAFChallenge(bodyText)) return "cooldown";

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

  // 3. 仅在没有结构化码时，才使用文本关键词兜底。
  // 关键词表是全网关唯一的“可故障转移”定义（workbuddy 账号切换与 exchange 路由切换共用），
  // 新增上游错误特征只改这里，不要在调用方另起一份内联表。
  //
  // 关键收紧（why）：4xx（除 402/403/429 外）是客户端错误，其响应体可能原样回显用户输入/代码片段
  // （如 400 body 里的 "unknown field 'quota'"）。若对这些状态跑通用关键词表，会把客户端错误
  // 误判成账号级额度/风控问题，进而对无辜账号做指数退避（streak++），污染冷却状态。
  // 因此 4xx-non-402/403/429 只认「无歧义的显式腾讯业务码」这种上游信号；通用词一律不触发。
  // 402 与 403 同等放行：402 Payment Required 几乎恒为余额/购卡问题（部分兼容上游用 402 报
  // insufficient credits），与 403 一样无 body 也冷却，避免真实欠费被判 fatal 失去 failover。
  // 5xx / status 0 / unknown 仍保留完整通用词表（上游瞬时故障，文本里的 quota/overloaded 是合理信号）。
  const isClientErrorOtherThanQuota = status >= 400 && status < 500 && status !== 402 && status !== 403 && status !== 429;

  // 显式腾讯业务码：即便被包在 4xx 里也属于明确的上游额度/风控信号，任何状态都认。
  const hasExplicitUpstreamCode =
    text.includes("11140") ||
    text.includes("11128") ||
    text.includes("14018") ||
    text.includes("6004");

  if (
    status === 403 ||
    status === 402 ||
    hasExplicitUpstreamCode ||
    (!isClientErrorOtherThanQuota && (
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
    ))
  ) {
    return "cooldown";
  }

  return "fatal";
}

// 纯函数：上游是否在说“这个模型不存在/不可用”（模型身份级错误）。
// 与配额/限流不同：换一个模型（不同 candidate）可能成功，所以 dispatch 允许它
// 在“后面还有不同模型的候选”时故障转移。注意边界：
//   - 只认身份信号（unavailable / not found / does not exist / invalid model），
//     不认 access/permission（密钥级，全局无解，转移无意义）
//   - workbuddy 账号循环不使用它（同一模型换账号试同一身份错误纯属浪费）。
export function isModelLevelError(bodyText = "") {
  const text = (bodyText || "").toLowerCase();
  return (
    text.includes("model is unavailable") ||
    text.includes("model not found") ||
    text.includes("no such model") ||
    text.includes("does not exist") ||
    text.includes("invalid model") ||
    text.includes("unknown model") ||
    text.includes("model_not_found")
  );
}

// 纯函数：判断腾讯在 200 状态里返回的业务错误码是否应触发退避。
// 返回 0 表示无业务错误；否则返回业务错误码。
export function businessErrorCode(resJson) {
  if (resJson && typeof resJson === "object" && resJson.code !== undefined && resJson.code !== 0) {
    return resJson.code;
  }
  return 0;
}
