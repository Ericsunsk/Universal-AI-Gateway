// 账号冷却持久层 —— 内存写穿缓存 + KV 跨 isolate 落盘 + 退避标记的唯一写入口。
// 调度决策（选谁、退避多久）在 scheduler.js；这里只管状态的存取。
import { computeCooldown, backoffMinutesForStreak } from "../../core/scheduler.js";

// 账号 429 / 额度耗尽动态退避记录: accountId -> { expiresAt: number, streak: number }
// 进程内为写穿缓存；跨 isolate 的真实状态落在 KV，否则每个 isolate 各退避各的，冷却形同虚设。
// 由调用方（orderAccounts 排序）读取，唯一写入口是 setAccountCooldown。
export const accountCooldownRecord = new Map();
const COOLDOWN_KV_PREFIX = "WB_COOLDOWN_";
const COOLDOWN_KV_MAX_TTL_S = 900; // KV 最小 TTL 60s；退避上限 8 分钟，留足余量

let lastHydrateTimestamp = 0;
const HYDRATE_THROTTLE_MS = 5 * 1000; // 5 秒防抖：同一 isolate 内 5 秒内只水合一次 KV，消除高并发下的无谓往返

function getKv(env) {
  return env?.GATEWAY_KV || env?.WORKBUDDY_KV || null;
}

// 把 KV 中的冷却记录水合进本 isolate 的缓存（5 秒内节流，避免高频并发下每请求做 KV 批量读）
export async function hydrateCooldowns(env, accounts, force = false) {
  const kv = getKv(env);
  if (!kv || !accounts?.length) return;
  const now = Date.now();
  if (!force && (now - lastHydrateTimestamp < HYDRATE_THROTTLE_MS)) {
    return;
  }
  lastHydrateTimestamp = now;

  const results = await Promise.allSettled(
    accounts.map(acc => kv.get(`${COOLDOWN_KV_PREFIX}${acc.id}`, "json"))
  );
  results.forEach((r, i) => {
    if (r.status !== "fulfilled" || !r.value) return;
    let record = r.value;
    if (typeof record === "string") {
      try { record = JSON.parse(record); } catch (e) { return; }
    }
    if (!record?.expiresAt || record.expiresAt < now) return; // 已过期，不写入缓存
    const local = accountCooldownRecord.get(accounts[i].id);
    // 以更晚的过期时间为准，避免本 isolate 的陈旧记录覆盖 KV 的更新
    if (!local || local.expiresAt < record.expiresAt) {
      accountCooldownRecord.set(accounts[i].id, record);
    }
  });
}

async function persistCooldown(env, accountId, record) {
  const kv = getKv(env);
  if (!kv) return;
  const ttlS = Math.max(60, Math.min(
    Math.ceil((record.expiresAt - Date.now()) / 1000) + 60,
    COOLDOWN_KV_MAX_TTL_S
  ));
  try {
    await kv.put(`${COOLDOWN_KV_PREFIX}${accountId}`, JSON.stringify(record), { expirationTtl: ttlS });
  } catch (e) {
    console.error(`Failed to persist cooldown for ${accountId}:`, e);
  }
}

async function markAccountRateLimited(account, env) {
  const record = computeCooldown(account.id, accountCooldownRecord);
  accountCooldownRecord.set(account.id, record);
  // 可靠落盘 KV 冷却记录（await 确保写入完成），跨 isolate 立即可见
  await persistCooldown(env, account.id, record);
  console.warn(`[WorkBuddy] Account "${account.name || account.id}" 429/rate-limited (streak ${record.streak}), cooling down for ${backoffMinutesForStreak(record.streak)}m...`);
}

async function clearAccountCooldown(account, env) {
  accountCooldownRecord.delete(account.id);
  // 同步清除 KV 中的冷却记录，避免其他 isolate 继续按旧记录跳过该账号
  const kv = getKv(env);
  if (kv) {
    try {
      await kv.delete(`${COOLDOWN_KV_PREFIX}${account.id}`);
    } catch (e) {
      console.error(`Failed to clear cooldown for ${account.id}:`, e);
    }
  }
}

// 冷却状态唯一写入口：调用方只传动作，不直接碰 Map / KV。
// action "cooldown" = 惩罚性退避并落盘；"clear" = 清除惩罚标记。
export async function setAccountCooldown(account, env, action) {
  if (action === "cooldown") {
    await markAccountRateLimited(account, env);
  } else {
    await clearAccountCooldown(account, env);
  }
}
