import { test } from "node:test";
import assert from "node:assert/strict";
import { hasGetBalance, hasOnSchedule, hasDailyCheckin } from "../src/providers/contract.js";

test("contract predicates detect optional provider capabilities", () => {
  assert.equal(hasGetBalance({ getBalance: () => {} }), true);
  assert.equal(hasGetBalance({}), false);
  assert.equal(hasGetBalance(null), false);

  assert.equal(hasOnSchedule({ onSchedule: () => {} }), true);
  assert.equal(hasOnSchedule({}), false);

  assert.equal(hasDailyCheckin({ doDailyCheckin: () => {} }), true);
  assert.equal(hasDailyCheckin({}), false);
});
