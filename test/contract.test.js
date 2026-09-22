import { test } from "node:test";
import assert from "node:assert/strict";
import { hasGetBalance, hasDailyCheckin, hasCallChat, hasCallMessages, wantsStreamedChat, hasTokenRefresh } from "../src/core/contract.js";

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
