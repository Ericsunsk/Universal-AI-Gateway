import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMinutesForStreak,
  orderAccounts,
  computeCooldown,
  classifyFailure,
  businessErrorCode,
  isModelLevelError,
  isWAFChallenge,
  hashString32,
  affinityStartIndex
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
test("classifyFailure: 429 → cooldown", () => {
  assert.equal(classifyFailure({ status: 429 }), "cooldown");
});

test("classifyFailure: 5xx → retry (no punishment)", () => {
  assert.equal(classifyFailure({ status: 500 }), "retry");
  assert.equal(classifyFailure({ status: 503 }), "retry");
  assert.equal(classifyFailure({ status: 502 }), "retry");
});

test("classifyFailure: 403 and quota/safety keywords → cooldown", () => {
  assert.equal(classifyFailure({ status: 403 }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "error 11140" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "error 11128" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "error 6004" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "error 14018" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "insufficient quota" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "rate limit exceeded" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "too many requests" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "service overloaded" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "service unavailable" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "endpoint is unavailable" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "FreeUsageLimitError" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "触发频率限制" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "账户欠费" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "余额不足" }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "安全审核拦截" }), "cooldown");
});

test("classifyFailure: other errors → fatal", () => {
  assert.equal(classifyFailure({ status: 400 }), "fatal");
  assert.equal(classifyFailure({ status: 404 }), "fatal");
  assert.equal(classifyFailure({ status: 200, text: "some normal message" }), "fatal");
});

test("classifyFailure: generic keyword in a 4xx-non-402/403/429 body does NOT punish the account", () => {
  // 4xx 是客户端错误，body 可能回显用户输入/代码片段；通用词不得触发账号退避（M4 回归）
  // 例外：402 与 403 同等放行（Payment Required 恒为余额问题，无 body 也冷却）
  assert.equal(classifyFailure({ status: 400, text: '{"message":"unknown field quota"}' }), "fatal");
  assert.equal(classifyFailure({ status: 400, text: "quota exceeded" }), "fatal");
  assert.equal(classifyFailure({ status: 422, text: "overloaded" }), "fatal");
  assert.equal(classifyFailure({ status: 401, text: "rate limit" }), "fatal");
  assert.equal(classifyFailure({ status: 402, text: "anything without quota words" }), "cooldown", "402 always cools like 403");
  assert.equal(classifyFailure({ status: 402, text: "余额不足" }), "cooldown", "402 quota cools");
});

test("classifyFailure: explicit Tencent code still cools down even on a 4xx", () => {
  // 显式腾讯业务码无歧义，即便被包在 400 里仍是上游额度/风控信号
  assert.equal(classifyFailure({ status: 400, text: "bad request: 11128" }), "cooldown");
  assert.equal(classifyFailure({ status: 400, text: "error 11140" }), "cooldown");
  assert.equal(classifyFailure({ status: 400, text: "error 14018" }), "cooldown");
  assert.equal(classifyFailure({ status: 400, text: "error 6004" }), "cooldown");
});

test("classifyFailure: 5xx semantics unchanged by the 4xx keyword narrowing", () => {
  assert.equal(classifyFailure({ status: 429, text: "anything" }), "cooldown");
  assert.equal(classifyFailure({ status: 503, text: "service unavailable" }), "retry");
  assert.equal(classifyFailure({ status: 500, text: "insufficient quota" }), "retry");
});

test("isModelLevelError detects model-identity errors only", () => {
  assert.equal(isModelLevelError("Model is unavailable"), true);
  assert.equal(isModelLevelError("model_not_found"), true);
  assert.equal(isModelLevelError("No such model: foo"), true);
  assert.equal(isModelLevelError("Invalid model"), true);
  assert.equal(isModelLevelError("insufficient quota"), false);
  assert.equal(isModelLevelError("access denied"), false);
  assert.equal(isModelLevelError(""), false);
  assert.equal(isModelLevelError(null), false);
});

test("classifyFailure: structured business code takes priority over text", () => {
  // 已知惩罚码 → cooldown
  assert.equal(classifyFailure({ status: 200, text: "", json: { code: 11140 } }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "", json: { code: 11128 } }), "cooldown");
  assert.equal(classifyFailure({ status: 200, text: "", json: { code: 6004 } }), "cooldown");
  // 未知非零业务码 → retry（切换但不惩罚；惩罚只给已知码）
  assert.equal(classifyFailure({ status: 200, text: "", json: { code: 99999 } }), "retry");
  // code 0 = 无业务错误，回退到状态码/文本判定
  assert.equal(classifyFailure({ status: 200, text: "some normal message", json: { code: 0 } }), "fatal");
  assert.equal(classifyFailure({ status: 200, text: "insufficient quota", json: { code: 0 } }), "cooldown");
});

test("businessErrorCode extracts Tencent code from 200 JSON", () => {
  assert.equal(businessErrorCode({ code: 0 }), 0);
  assert.equal(businessErrorCode({ code: 11128 }), 11128);
  assert.equal(businessErrorCode({ code: undefined }), 0);
  assert.equal(businessErrorCode(null), 0);
});

test("hashString32 is deterministic with avalanche on different inputs", () => {
  assert.equal(hashString32("sess-1"), hashString32("sess-1"));
  assert.notEqual(hashString32("sess-1"), hashString32("sess-2"));
  assert.equal(hashString32(""), 0x811c9dc5);
});

test("affinityStartIndex pins a key to one healthy account", () => {
  assert.equal(affinityStartIndex("sid:abc", 3), affinityStartIndex("sid:abc", 3));
  assert.ok(affinityStartIndex("sid:abc", 3) < 3);
  assert.equal(affinityStartIndex(null, 3), 0);
  assert.equal(affinityStartIndex("x", 0), 0);
});

test("orderAccounts with affinityKey sticks to one account and drifts on cooldown", () => {
  const empty = new Map();
  const first = orderAccounts(accts, empty, now, 999, "sid:s1")[0].id;
  // 同一 key 多次调用落点一致（rrIndex 变化不影响）
  assert.equal(orderAccounts(accts, empty, now, 0, "sid:s1")[0].id, first);
  assert.equal(orderAccounts(accts, empty, now, 1, "sid:s1")[0].id, first);
  // 首选账号被冷却 → 漂移到下一健康账号（上游缓存虽冷但请求不挂）
  const cooled = new Map([[first, { expiresAt: now + 60_000, streak: 1 }]]);
  const drifted = orderAccounts(accts, cooled, now, 0, "sid:s1")[0].id;
  assert.notEqual(drifted, first);
  // 无 key 时旧语义不变
  assert.deepEqual(orderAccounts(accts, empty, now, 1).map(a => a.id), ["b", "c", "a"]);
});

test("isWAFChallenge detects captcha/WAF pages only", () => {
  assert.equal(isWAFChallenge("<html>aliyun_waf challenge"), true);
  assert.equal(isWAFChallenge('{"ret":["FAIL_SYS_USER_VALIDATE"]}'), true);
  assert.equal(isWAFChallenge("请拖动滑块完成拼图"), true);
  assert.equal(isWAFChallenge("天天中彩票"), false);
  assert.equal(isWAFChallenge("my quota is low"), false);
  assert.equal(isWAFChallenge(""), false);
  assert.equal(isWAFChallenge(null), false);
});

test("classifyFailure: WAF challenge cools down even on misleading status", () => {
  assert.equal(classifyFailure({ status: 403, text: "<html>aliyun_waf</html>" }), "cooldown");
  assert.equal(classifyFailure({ status: 302, text: "redirect to _____tmd_____/punish?x5secdata=1" }), "cooldown");
  assert.equal(classifyFailure({ status: 400, text: "<html>aliyun_waf</html>" }), "cooldown");
  assert.equal(classifyFailure({ status: 400, text: "bad request" }), "fatal", "plain 400 stays fatal");
});

// ---- Candidate 02：classifyFailure 是失败分类的唯一边界 ----
// 关键契约：调用方只交**原始证据**，JSON 解析由分类器完成（调用方不再预处理）。

test("classifyFailure parses RAW JSON text itself (caller need not pre-parse)", () => {
  // 腾讯 11140 包在 200 里：文本形态直接判 cooldown，无需调用方先 JSON.parse
  assert.equal(classifyFailure({ status: 200, text: '{"code":11140,"msg":"quota"}' }), "cooldown");
  // 未知业务码 → retry（切换不惩罚）
  assert.equal(classifyFailure({ status: 200, text: '{"code":9999,"msg":"weird"}' }), "retry");
});

test("classifyFailure accepts pre-parsed json as evidence (avoids double parse)", () => {
  const json = { code: 11128, msg: "safety" };
  assert.equal(classifyFailure({ status: 200, text: JSON.stringify(json), json }), "cooldown");
  // 显式 json:null 表示“调用方确认无结构体”，此时不尝试解析 text（严格按文本规则）
  assert.equal(classifyFailure({ status: 400, text: "unknown field 'quota'", json: null }), "fatal");
});

test("classifyFailure is self-consistent on raw-text evidence (no alias)", () => {
  const cases = [
    { status: 429, text: "rate limited" },
    { status: 503, text: "overloaded" },
    { status: 400, text: "bad request" },
    { status: 200, text: '{"code":6004,"msg":"risk"}' },
    { status: 403, text: "" },
    { status: 402, text: "insufficient credits" },
    // 以下用例专门覆盖“仅靠 JSON 解析才能得出动作、且 code 不是文本关键词”的场景
    { status: 200, text: '{"code":9999,"msg":"weird"}' },   // 未知业务码 → retry
    { status: 200, text: '{"code":11140,"msg":"quota"}' }    // 已知业务码 → cooldown
  ];
  const expected = ["cooldown", "retry", "fatal", "cooldown", "cooldown", "cooldown", "retry", "cooldown"];
  cases.forEach((c, i) => {
    assert.equal(classifyFailure(c), expected[i], `mismatch for ${JSON.stringify(c)}`);
  });
  // 缺省自解析出未知业务码 → retry；显式传 null（确认无结构体、不解析）→ fatal。
  // 两者语义不同，此处锁死各自结果。
  assert.equal(classifyFailure({ status: 200, text: '{"code":9999}' }), "retry");
  assert.equal(classifyFailure({ status: 200, text: '{"code":9999}', json: null }), "fatal");
});

test("classifyFailure tolerates malformed / non-JSON text without throwing", () => {
  assert.equal(classifyFailure({ status: 500, text: "<html>not json</html>" }), "retry");
  assert.equal(classifyFailure({ status: 0, text: "" }), "fatal");
  assert.equal(classifyFailure({}), "fatal");
  assert.equal(classifyFailure(), "fatal");
  assert.equal(classifyFailure({ status: 400, text: "{broken json" }), "fatal");
});
