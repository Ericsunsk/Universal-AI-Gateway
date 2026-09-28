import { test } from "node:test";
import assert from "node:assert/strict";
import { hasGetBalance, hasDailyCheckin, hasCallChat, hasCallMessages, wantsStreamedChat, hasTokenRefresh, needsReasoningScrub, REASONING_DIALECTS } from "../src/core/contract.js";
import { supportedProviderTypes, createProvider, registerProvider } from "../src/providers/index.js";
import { ProviderFleet } from "../src/providers/fleet.js";

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
//
// 本条覆盖 *仓内* adapter（supportedProviderTypes 的真值来源）。注意其边界：
// 以 FleetConfig 条目新增、方言由 config 驱动的第三方上游不在此列，由下面
// 两条用例（注册期校验 + fleet 构建期 quarantine）覆盖。
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
  }

  // 方言与 type 解耦：WorkBuddy 句柄的 type 恰好同名，但判定只认 dialect。
  // 按 type 查找而非固定下标 —— 此前用 concrete[2] 假设了手工列表的顺序，
  // 枚举改为 registry 真值后顺序由注册序决定，下标断言会误伤。
  const wb = concrete.find((p) => p.type === "workbuddy");
  assert.ok(wb, "registry must include the workbuddy provider");
  assert.equal(needsReasoningScrub(wb), true);
  assert.equal(needsReasoningScrub({ type: "workbuddy", reasoningDialect: "openai" }), false);
});

// needsReasoningScrub 是纯谓词：非法/缺失方言返回 false，绝不抛错。
// 抛错会把配置违约变成每请求异常，并被 runFailover 误渲染为 502。
test("needsReasoningScrub is a total predicate that never throws", () => {
  assert.equal(needsReasoningScrub(null), false);
  assert.equal(needsReasoningScrub({}), false);
  assert.equal(needsReasoningScrub({ reasoningDialect: undefined }), false);
  assert.equal(needsReasoningScrub({ reasoningDialect: "myvendor" }), false);
  assert.equal(needsReasoningScrub({ reasoningDialect: "workbuddy" }), true);
  assert.equal(needsReasoningScrub({ reasoningDialect: "openai" }), false);
});

// 注册期是结构性不变量的卡点：字面量声明了非法方言的 adapter 必须注册失败。
// 这覆盖「新目录 + 一行 registerProvider」路径，比逐消费端特判更浅。
test("registerProvider rejects a constructor with an invalid literal dialect", () => {
  class BadDialect { callChat() {} }
  BadDialect.prototype.reasoningDialect = "myvendor";
  assert.throws(() => registerProvider("t-bad-dialect", BadDialect), /invalid reasoningDialect/);

  class GoodDialect { callChat() {} }
  GoodDialect.prototype.reasoningDialect = "openai";
  assert.doesNotThrow(() => registerProvider("t-good-dialect", GoodDialect));

  // config 驱动的方言在注册期探不出，必须放行（由 fleet 构建期兜底）。
  class ConfigDriven { constructor(cfg) { this.reasoningDialect = cfg.reasoningDialect; } callChat() {} }
  assert.doesNotThrow(() => registerProvider("t-config-driven", ConfigDriven));
});

// fleet 构建期兜底：方言非法的实例被跳过而非插入，避免「看着健康、每个请求 500」。
test("fleet quarantines an instance with an undeclared dialect", () => {
  class ConfigDriven { constructor(cfg) { this.reasoningDialect = cfg.reasoningDialect; } callChat() {} }
  registerProvider("t-config-driven-2", ConfigDriven);

  const fleet = new ProviderFleet({
    providers: [
      { id: "p-bad", type: "t-config-driven-2" },
      { id: "p-ok", type: "t-config-driven-2", reasoningDialect: "anthropic" }
    ]
  });
  assert.equal(fleet.getProvider("p-bad"), null, "非法方言的 provider 必须被隔离");
  assert.ok(fleet.getProvider("p-ok"), "合法方言的 provider 必须保留");
});
