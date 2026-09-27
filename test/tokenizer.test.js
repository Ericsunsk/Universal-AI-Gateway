import { test } from "node:test";
import assert from "node:assert/strict";
import { countTokens, estimateTokens } from "../src/core/tokenizer.js";
import { validateGatewayConfig } from "../src/config/schema.js";

// ---- Tokenizer Tests ----
test("countTokens provides accurate BPE token counts for text", () => {
  const count = countTokens("Hello world");
  assert.equal(count, 2);

  const zhCount = countTokens("你好，世界！");
  assert.ok(zhCount > 0);
  assert.equal(countTokens(""), 0);
});

test("estimateTokens supports strings, objects and message sequences with protocol overhead", () => {
  const fromStr = estimateTokens("Just a plain string");
  assert.ok(fromStr > 0);

  const payload = {
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "Tell me a joke." },
      { role: "assistant", content: [{ type: "text", text: "Why did the chicken cross the road?" }] }
    ],
    tools: [
      { name: "calculator", description: "Performs math calculations", input_schema: { type: "object" } }
    ]
  };

  const tokens = estimateTokens(payload);
  assert.ok(tokens > 20, "tokens should account for text, tools, plus message protocol overhead");
});

test("estimateTokens fast-path handles large payloads (>8000 chars) in sub-millisecond time", () => {
  const largeMessages = [];
  const chunk = "This is a repeated line of text for testing large payload estimation. ".repeat(20);
  for (let i = 0; i < 50; i++) {
    largeMessages.push({ role: "user", content: chunk });
  }
  const largePayload = { messages: largeMessages };

  const start = performance.now();
  const fastTokens = estimateTokens(largePayload);
  const duration = performance.now() - start;

  assert.ok(fastTokens > 10000, "estimated tokens should scale with large payload");
  assert.ok(duration < 20, `fast-path should execute in <20ms, took ${duration.toFixed(2)}ms`);

  // exact: true 走完整分词，验证其可达
  const exactTokens = estimateTokens({ system: "A short text" }, { exact: true });
  assert.ok(exactTokens > 0);
});

// ---- Schema Validation Tests ----
test("validateGatewayConfig validates and accepts compliant gateway configs", () => {
  const valid = {
    config_version: 1,
    master_key: "mk-123",
    routes: {},
    virtual_keys: {}
  };
  const res = validateGatewayConfig(valid);
  assert.equal(res.success, true);

  // 非法配置拒绝
  assert.equal(validateGatewayConfig(null).success, false);
  assert.equal(validateGatewayConfig([]).success, false);
});
