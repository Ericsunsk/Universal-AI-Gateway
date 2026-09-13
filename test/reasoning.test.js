import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReasoningIntent,
  applyReasoningToPayload,
  budgetToEffortLevel,
  effortLevelToBudget
} from "../src/exchange/reasoning.js";

test("budgetToEffortLevel and effortLevelToBudget convert accurately", () => {
  assert.equal(budgetToEffortLevel(1024), "minimal");
  assert.equal(budgetToEffortLevel(2048), "low");
  assert.equal(budgetToEffortLevel(6000), "medium");
  assert.equal(budgetToEffortLevel(12000), "high");
  assert.equal(budgetToEffortLevel(32000), "xhigh");

  assert.equal(effortLevelToBudget("minimal"), 1024);
  assert.equal(effortLevelToBudget("low"), 2048);
  assert.equal(effortLevelToBudget("medium"), 4096);
  assert.equal(effortLevelToBudget("high"), 12000);
  assert.equal(effortLevelToBudget("xhigh"), 32000);
});

test("parseReasoningIntent extracts intent from model suffix", () => {
  const resHigh = parseReasoningIntent({ model: "muse-spark-1.3[high]" });
  assert.equal(resHigh.cleanModel, "muse-spark-1.3");
  assert.equal(resHigh.level, "high");
  assert.equal(resHigh.enabled, true);
  assert.equal(resHigh.budgetTokens, 12000);

  const resOff = parseReasoningIntent({ model: "ling-3.0-flash[off]" });
  assert.equal(resOff.cleanModel, "ling-3.0-flash");
  assert.equal(resOff.enabled, false);

  const resContext = parseReasoningIntent({ model: "claude-3-7-sonnet[1M]" });
  assert.equal(resContext.cleanModel, "claude-3-7-sonnet");
  assert.equal(resContext.level, null, "Context tag [1M] is not reasoning level");
});

test("parseReasoningIntent extracts intent from Anthropic thinking block", () => {
  const res = parseReasoningIntent({
    model: "claude-3-7-sonnet-20250219",
    body: {
      thinking: { type: "enabled", budget_tokens: 8000 }
    }
  });
  assert.equal(res.cleanModel, "claude-3-7-sonnet-20250219");
  assert.equal(res.enabled, true);
  assert.equal(res.budgetTokens, 8000);
  assert.equal(res.level, "medium");

  const resDisabled = parseReasoningIntent({
    model: "claude-3-7-sonnet-20250219",
    body: {
      thinking: { type: "disabled" }
    }
  });
  assert.equal(resDisabled.enabled, false);
});

test("parseReasoningIntent extracts intent from OpenAI reasoning_effort", () => {
  const res = parseReasoningIntent({
    model: "o3-mini",
    body: { reasoning_effort: "low" }
  });
  assert.equal(res.enabled, true);
  assert.equal(res.level, "low");
});

test("applyReasoningToPayload adapts to Anthropic provider correctly", () => {
  const intent = {
    cleanModel: "claude-3-7-sonnet-20250219",
    enabled: true,
    level: "high",
    budgetTokens: 12000
  };

  const payload = {
    model: "claude-3-7-sonnet-20250219",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.7
  };

  const adapted = applyReasoningToPayload(payload, intent, "anthropic", "claude-3-7-sonnet-20250219");
  assert.deepEqual(adapted.thinking, { type: "enabled", budget_tokens: 12000 });
  assert.equal(adapted.temperature, 1.0, "Anthropic Extended Thinking requires temperature 1.0");

  const disabledIntent = { cleanModel: "claude", enabled: false, level: "minimal" };
  const disabledPayload = applyReasoningToPayload({ model: "claude" }, disabledIntent, "anthropic", "claude");
  assert.deepEqual(disabledPayload.thinking, { type: "disabled" });
});

test("applyReasoningToPayload adapts to OpenAI provider correctly", () => {
  const intent = {
    cleanModel: "o3-mini",
    enabled: true,
    level: "xhigh"
  };

  const payload = { model: "o3-mini", messages: [] };
  const adapted = applyReasoningToPayload(payload, intent, "openai", "o3-mini");
  assert.equal(adapted.reasoning_effort, "high", "xhigh maps to OpenAI high");
  assert.deepEqual(adapted.reasoning, { effort: "high", enabled: true });
});

test("applyReasoningToPayload adapts to OpenCode models specifically", () => {
  // Muse Spark 支持 xhigh
  const museIntent = { cleanModel: "muse-spark-1.3", enabled: true, level: "xhigh" };
  const musePayload = applyReasoningToPayload({ model: "muse-spark-1.3" }, museIntent, "opencode", "muse-spark-1.3");
  assert.equal(musePayload.reasoning_effort, "xhigh");
  assert.deepEqual(musePayload.reasoning, { effort: "xhigh", enabled: true });

  // Ling 3.0 支持 toggle
  const lingIntent = { cleanModel: "ling-3.0", enabled: false };
  const lingPayload = applyReasoningToPayload({ model: "ling-3.0-flash-fin-free" }, lingIntent, "opencode", "ling-3.0-flash-fin-free");
  assert.deepEqual(lingPayload.reasoning, { enabled: false });
  assert.equal(lingPayload.reasoning_effort, undefined);
});

test("applyReasoningToPayload safely sanitizes WorkBuddy provider to prevent 400 errors", () => {
  const intent = { cleanModel: "deepseek-v4.1-flash", enabled: true, level: "high" };
  const payload = {
    model: "deepseek-v4.1-flash",
    reasoning_effort: "high",
    thinking: { type: "enabled" }
  };

  const adapted = applyReasoningToPayload(payload, intent, "workbuddy", "deepseek-v4.1-flash");
  assert.equal(adapted.reasoning_effort, undefined, "Must remove reasoning_effort for WorkBuddy");
  assert.equal(adapted.reasoning, undefined, "Must remove reasoning for WorkBuddy");
  assert.equal(adapted.thinking, undefined, "Must remove thinking for WorkBuddy");
});
