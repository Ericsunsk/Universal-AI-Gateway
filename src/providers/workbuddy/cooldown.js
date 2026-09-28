// 账号冷却持久层 —— 内存写穿缓存 + KV 跨 isolate 落盘 + 退避标记的唯一写入口。
// 调度决策（选谁、退避多久）在 scheduler.js；这里只管状态的存取。
import { computeCooldown, backoffMinutesForStreak } from "../../core/scheduler.js";
import { log } from "../../logging/logger.js";

// 账号 429 / 额度耗尽动态退避记录: accountId -> { expiresAt: number, streak: number }
// 进程内为写穿缓存；跨 isolate 的真实状态落在 KV，否则每个 isolate 各退避各的，冷却形同虚设。
// 由调用方（orderAccounts 排序）读取，唯一写入口是 setAccountCooldown。
export const accountCooldownRecord = new Map();
const COOLDOWN_KV_PREFIX = "WB_COOLDOWN_";
const COOLDOWN_KV_MAX_TTL_S = 900; // KV 最小 TTL 60s；退避上限 8 分钟，留足余量

// 本 isolate 曾观测到「KV 中可能存在冷却记录」的账号 id。
//
// 用于把 clearAccountCooldown 的 KV 删除限定在真正必要的情形：账号从未冷却过
// （绝大多数成功请求）时无需每次发一次 KV delete，避免写放大；而一旦本 isolate
// 写过冷却、或水合到过有效冷却，就必须删——因为陈旧的高 streak 会跨 isolate 传染，
// 使退避棘轮不可回落。基数受账号池上限约束，非按流量增长。
const kvCooldownMayExist = new Set();

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
      try { record = JSON.parse(record); } catch { return; }
    }
    // 已过期 = 该账号已从惩罚中恢复，**不得把 streak 带回来**。
    // 曾经只 return（不水合），但 KV 里的高 streak 依然存在：下一次 429 会从高水位继续
    // 爬升，把账号钉死在 BACKOFF_MAX。恢复即清零，使退避可回落。
    if (!record?.expiresAt || record.expiresAt < now) {
      if (record?.streak) {
        accountCooldownRecord.delete(accounts[i].id);
        kvCooldownMayExist.add(accounts[i].id); // 让后续成功路径负责清掉这条陈旧 KV
      }
      return;
    }
    kvCooldownMayExist.add(accounts[i].id); // 水合到有效冷却 → KV 确有记录，后续需删
    const local = accountCooldownRecord.get(accounts[i].id);
    // 以更晚的过期时间为准，避免本 isolate 的陈旧记录覆盖 KV 的更新
    if (!local || local.expiresAt < record.expiresAt) {
      accountCooldownRecord.set(accounts[i].id, record);
    }
  });
}

async function persistCooldown(env, accountId, record) {
  kvCooldownMayExist.add(accountId); // KV 即将持有记录，后续成功路径须负责清除
  const kv = getKv(env);
  if (!kv) return;
  const ttlS = Math.max(60, Math.min(
    Math.ceil((record.expiresAt - Date.now()) / 1000) + 60,
    COOLDOWN_KV_MAX_TTL_S
  ));
  try {
    await kv.put(`${COOLDOWN_KV_PREFIX}${accountId}`, JSON.stringify(record), { expirationTtl: ttlS });
  } catch (e) {
    log.error("Failed to persist cooldown", { account: accountId, error: e?.message || String(e) });
  }
}

async function markAccountRateLimited(account, env) {
  const record = computeCooldown(account.id, accountCooldownRecord);
  accountCooldownRecord.set(account.id, record);
  // 可靠落盘 KV 冷却记录（await 确保写入完成），跨 isolate 立即可见
  await persistCooldown(env, account.id, record);
  log.warn("Account rate-limited, cooling down", { account: account.name || account.id, streak: record.streak, backoff_min: backoffMinutesForStreak(record.streak) });
}

async function clearAccountCooldown(account, env) {
  // 无条件清内存；KV 删除则按「本 isolate 是否可能遗留过冷却记录」判定。
  //
  // 旧实现是 `if (!delete(...)) return` —— 本 isolate 无记录时连 KV 都不删。
  // 该优化建立在「过期记录会被水合自动忽略，自愈」的前提上，而该前提不成立：
  // hydrateCooldowns 对过期记录只是不水合，并不删除 KV 条目，于是高 streak 作为
  // 陈旧状态残留，被其他 isolate 重新水合后继续爬升 —— 账号被永久钉在
  // BACKOFF_MAX（streak 单调递增，全仓无复位路径）。
  //
  // 现在用 kvCooldownMayExist 精确限定：从未冷却过的账号（绝大多数）依旧零 KV 写，
  // 而遗留过记录的账号一定被清干净。
  const wasPresent = accountCooldownRecord.delete(account.id);
  const mayHaveKv = wasPresent || kvCooldownMayExist.delete(account.id);
  if (!mayHaveKv) return;
  const kv = getKv(env);
  if (kv) {
    try {
      await kv.delete(`${COOLDOWN_KV_PREFIX}${account.id}`);
    } catch (e) {
      log.error("Failed to clear cooldown", { account: account.id, error: e?.message || String(e) });
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
