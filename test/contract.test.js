import { test } from "node:test";
import assert from "node:assert/strict";
import { hasGetBalance, hasDailyCheckin, hasCallChat, hasCallMessages, wantsStreamedChat, hasTokenRefresh, needsReasoningScrub, REASONING_DIALECTS } from "../src/core/contract.js";
import { OpenAIStandardProvider } from "../src/providers/openai_standard.js";
import { AnthropicStandardProvider } from "../src/providers/anthropic_standard.js";
import { WorkBuddyProvider } from "../src/providers/workbuddy/index.js";

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
test("every concrete provider declares a valid reasoning dialect", () => {
  const concrete = [
    new OpenAIStandardProvider({ id: "o", config: {} }, {}),
    new AnthropicStandardProvider({ id: "a", config: {} }, {}),
    new WorkBuddyProvider({ id: "w" }, {})
  ];
  for (const p of concrete) {
    assert.ok(
      REASONING_DIALECTS.includes(p.reasoningDialect),
      `${p.constructor.name} 未声明合法 reasoningDialect，实为 ${JSON.stringify(p.reasoningDialect)}`
    );
    // 声明即生效：不得抛错（抛错即意味着未声明）。
    assert.doesNotThrow(() => needsReasoningScrub(p));
  }

  // 方言与 type 解耦：WorkBuddy 句柄的 type 恰好同名，但判定只认 dialect。
  const wb = concrete[2];
  assert.equal(wb.type, "workbuddy");
  assert.equal(needsReasoningScrub(wb), true);
  assert.equal(needsReasoningScrub({ type: "workbuddy", reasoningDialect: "openai" }), false);
});
