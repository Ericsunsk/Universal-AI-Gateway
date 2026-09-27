import { test } from "node:test";
import assert from "node:assert/strict";
import { hasGetBalance, hasDailyCheckin, hasCallChat, hasCallMessages, wantsStreamedChat, hasTokenRefresh, needsReasoningScrub, REASONING_DIALECTS } from "../src/core/contract.js";
import { supportedProviderTypes, createProvider } from "../src/providers/index.js";

test("contract predicates detect optional provider capabilities", () => {
  assert.equal(hasGetBalance({ getBalance: () => {} }), true);
  assert.equal(hasGetBalance({}), false);
  assert.equal(hasGetBalance(null), false);

  assert.equal(hasDailyCheckin({ doDailyCheckin: () => {} }), true);
  assert.equal(hasDailyCheckin({}), false);
});

test("contract probes cover the dispatch hot path (no type switch)", () => {
  const anthropicLike = { callMessages: async () => {}, callChat: async () => {} };
  const openaiLike = { callChat: async () => {} };
  assert.equal(hasCallMessages(anthropicLike), true);
  assert.equal(hasCallMessages(openaiLike), false);
  assert.equal(hasCallChat(openaiLike), true);
  assert.equal(hasCallChat({}), false);
  assert.equal(hasCallChat(null), false);

  assert.equal(wantsStreamedChat({ forceStream: true }), true);
  assert.equal(wantsStreamedChat({}), false);
  assert.equal(wantsStreamedChat({ forceStream: "yes" }), false);

  assert.equal(hasTokenRefresh({ refreshAccessToken: async () => {} }), true);
  assert.equal(hasTokenRefresh({}), false);
});

// 每个真实 provider 必须显式声明推理方言，不得依赖 type 字符串兜底推断。
// 新增上游若忘记声明，needsReasoningScrub 会抛错——本用例把该违约挡在 CI 上。
//
// 枚举取自 registry 真值（supportedProviderTypes），不再硬编码列表：
// 此前手工维护 3 个构造调用，第 4 个 provider 注册后若没人记得改这里，
// 契约就会对它静默失效。现在注册即纳入校验。
test("every concrete provider declares a valid reasoning dialect", () => {
  const concrete = supportedProviderTypes().map(
    (t) => createProvider({ type: t, id: t, config: {} }, {})
  );
  assert.ok(concrete.length > 0, "registry must expose at least one provider");
  for (const p of concrete) {
    assert.ok(
      REASONING_DIALECTS.includes(p.reasoningDialect),
      `${p.constructor.name} 未声明合法 reasoningDialect，实为 ${JSON.stringify(p.reasoningDialect)}`
    );
    // 声明即生效：不得抛错（抛错即意味着未声明）。
    assert.doesNotThrow(() => needsReasoningScrub(p));
  }

  // 方言与 type 解耦：WorkBuddy 句柄的 type 恰好同名，但判定只认 dialect。
  // 按 type 查找而非固定下标 —— 此前用 concrete[2] 假设了手工列表的顺序，
  // 枚举改为 registry 真值后顺序由注册序决定，下标断言会误伤。
  const wb = concrete.find((p) => p.type === "workbuddy");
  assert.ok(wb, "registry must include the workbuddy provider");
  assert.equal(needsReasoningScrub(wb), true);
  assert.equal(needsReasoningScrub({ type: "workbuddy", reasoningDialect: "openai" }), false);
});
