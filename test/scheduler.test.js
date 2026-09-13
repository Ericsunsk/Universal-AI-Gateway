import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMinutesForStreak,
  orderAccounts,
  computeCooldown,
  classify,
  businessErrorCode
} from "../src/core/scheduler.js";

// ---- 退避时长：1 -> 2 -> 4 -> 8（封顶） ----
test("backoffMinutesForStreak follows exponential capped at 8", () => {
  assert.equal(backoffMinutesForStreak(1), 1);
  assert.equal(backoffMinutesForStreak(2), 2);
  assert.equal(backoffMinutesForStreak(3), 4);
  assert.equal(backoffMinutesForStreak(4), 8);
  assert.equal(backoffMinutesForStreak(5), 8); // 封顶
  assert.equal(backoffMinutesForStreak(6), 8);
});

// ---- 账号排序 ----
const accts = ["a", "b", "c"].map(id => ({ id }));
const now = 1_000_000;

test("orderAccounts round-robins healthy accounts", () => {
  const empty = new Map();
  // rrIndex 0 → 从 a 开始
  assert.deepEqual(orderAccounts(accts, empty, now, 0).map(a => a.id), ["a", "b", "c"]);
  // rrIndex 1 → 从 b 开始
  assert.deepEqual(orderAccounts(accts, empty, now, 1).map(a => a.id), ["b", "c", "a"]);
  // rrIndex 2 → 从 c 开始
  assert.deepEqual(orderAccounts(accts, empty, now, 2).map(a => a.id), ["c", "a", "b"]);
});

test("orderAccounts puts healthy before cooling", () => {
  const map = new Map([["b", { expiresAt: now + 1000, streak: 1 }]]);
  const ids = orderAccounts(accts, map, now, 0).map(a => a.id);
  assert.equal(ids[0], "a");
  assert.equal(ids[1], "c");
  assert.equal(ids[2], "b"); // 冷却的排最后
});

test("orderAccounts falls back to cooling accounts sorted by expiry when none healthy", () => {
  const map = new Map([
    ["a", { expiresAt: now + 5000, streak: 1 }],
    ["b", { expiresAt: now + 1000, streak: 1 }],
    ["c", { expiresAt: now + 3000, streak: 1 }]
  ]);
  const ids = orderAccounts(accts, map, now, 0).map(a => a.id);
  // 最早到期的 b 排最前
  assert.equal(ids[0], "b");
  assert.equal(ids[1], "c");
  assert.equal(ids[2], "a");
});

test("orderAccounts does not mutate input", () => {
  const map = new Map();
  const input = [...accts];
  orderAccounts(input, map, now, 0);
  assert.deepEqual(input.map(a => a.id), ["a", "b", "c"]);
});

// ---- 退避计算 ----
test("computeCooldown increments streak and advances expiry", () => {
  const map = new Map();
  const rec1 = computeCooldown("a", map, now);
  assert.equal(rec1.streak, 1);
  assert.equal(rec1.expiresAt, now + 1 * 60 * 1000);

  const map2 = new Map([["a", rec1]]);
  const rec2 = computeCooldown("a", map2, now);
  assert.equal(rec2.streak, 2);
  assert.equal(rec2.expiresAt, now + 2 * 60 * 1000);
});

// ---- 错误分类 ----
test("classify: 429 → cooldown", () => {
  assert.equal(classify(429), "cooldown");
});

test("classify: 5xx → retry (no punishment)", () => {
  assert.equal(classify(500), "retry");
  assert.equal(classify(503), "retry");
  assert.equal(classify(502), "retry");
});

test("classify: 403 and quota/safety keywords → cooldown", () => {
  assert.equal(classify(403), "cooldown");
  assert.equal(classify(200, "error 11140"), "cooldown");
  assert.equal(classify(200, "error 11128"), "cooldown");
  assert.equal(classify(200, "error 6004"), "cooldown");
  assert.equal(classify(200, "error 14018"), "cooldown");
  assert.equal(classify(200, "insufficient quota"), "cooldown");
  assert.equal(classify(200, "rate limit exceeded"), "cooldown");
  assert.equal(classify(200, "too many requests"), "cooldown");
  assert.equal(classify(200, "service overloaded"), "cooldown");
  assert.equal(classify(200, "service unavailable"), "cooldown");
  assert.equal(classify(200, "endpoint is unavailable"), "cooldown");
  assert.equal(classify(200, "FreeUsageLimitError"), "cooldown");
  assert.equal(classify(200, "触发频率限制"), "cooldown");
  assert.equal(classify(200, "账户欠费"), "cooldown");
  assert.equal(classify(200, "余额不足"), "cooldown");
  assert.equal(classify(200, "安全审核拦截"), "cooldown");
});

test("classify: other errors → fatal", () => {
  assert.equal(classify(400), "fatal");
  assert.equal(classify(404), "fatal");
  assert.equal(classify(200, "some normal message"), "fatal");
});

test("classify: structured business code takes priority over text", () => {
  // 已知惩罚码 → cooldown
  assert.equal(classify(200, "", { code: 11140 }), "cooldown");
  assert.equal(classify(200, "", { code: 11128 }), "cooldown");
  assert.equal(classify(200, "", { code: 6004 }), "cooldown");
  // 未知非零业务码 → retry（切换但不惩罚；惩罚只给已知码）
  assert.equal(classify(200, "", { code: 99999 }), "retry");
  // code 0 = 无业务错误，回退到状态码/文本判定
  assert.equal(classify(200, "some normal message", { code: 0 }), "fatal");
  assert.equal(classify(200, "insufficient quota", { code: 0 }), "cooldown");
});

test("businessErrorCode extracts Tencent code from 200 JSON", () => {
  assert.equal(businessErrorCode({ code: 0 }), 0);
  assert.equal(businessErrorCode({ code: 11128 }), 11128);
  assert.equal(businessErrorCode({ code: undefined }), 0);
  assert.equal(businessErrorCode(null), 0);
});
