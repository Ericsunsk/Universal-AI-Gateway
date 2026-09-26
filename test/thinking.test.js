import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ThinkingAccumulator,
  isInboundThinkingBlock,
  shouldDiscardInboundThinking,
  shouldEmitTextBlock,
  SYNTHETIC_THINKING_SIGNATURE
} from "../src/exchange/thinking.js";

// 思维链概念的归属测试。此前该概念散在 reasoning.js / transform.js / stream.js 四处，
// 只能端到端覆盖；本文件以 (方向 × 场景) 表驱动，直接打在概念上。

test("inbound: every thinking-shaped block is recognised and discarded", () => {
  const cases = [
    [{ type: "thinking", thinking: "cot" }, true],
    [{ type: "redacted_thinking", data: "xx" }, true],
    // 非思维链块一律不拦——误拦会把正文/工具结果吃掉。
    [{ type: "text", text: "hi" }, false],
    [{ type: "tool_use", id: "t1" }, false],
    [{ type: "tool_result", tool_use_id: "t1" }, false],
    [{ type: "image", source: {} }, false],
    [{ type: "document", source: {} }, false],
    [{}, false],
    [null, false],
    [undefined, false]
  ];
  for (const [block, expected] of cases) {
    assert.equal(isInboundThinkingBlock(block), expected, `isInboundThinkingBlock(${JSON.stringify(block)})`);
    assert.equal(shouldDiscardInboundThinking(block), expected, `shouldDiscardInboundThinking(${JSON.stringify(block)})`);
  }
});

test("outbound: accumulated text becomes a signed thinking block, or null when empty", () => {
  const acc = new ThinkingAccumulator();
  assert.equal(acc.hasContent, false);
  assert.equal(acc.toAnthropicBlock(), null, "空思维链不得产出块");

  acc.push("step one. ");
  acc.push("step two.");
  assert.equal(acc.text, "step one. step two.");
  assert.equal(acc.hasContent, true);
  assert.equal(acc.estimatedChars(), "step one. step two.".length);

  const block = acc.toAnthropicBlock();
  assert.equal(block.type, "thinking");
  assert.equal(block.thinking, "step one. step two.");
  // 出站思维链必须带签名，否则客户端视为非法块。
  assert.equal(block.signature, SYNTHETIC_THINKING_SIGNATURE);
  assert.ok(block.signature.length > 0);
});

test("outbound: non-streaming reasoning replaces, streaming deltas append", () => {
  // 流式：逐 chunk 追加
  const streamed = new ThinkingAccumulator();
  for (const d of ["a", "b", "c"]) streamed.push(d);
  assert.equal(streamed.text, "abc");

  // 非流式：上游一次性给出完整 reasoning，覆盖而非追加
  const packed = new ThinkingAccumulator();
  packed.push("partial");
  packed.reset("full reasoning");
  assert.equal(packed.text, "full reasoning");

  // 非法入参不得污染状态
  packed.push(undefined);
  packed.push(null);
  packed.push(42);
  packed.reset(undefined);
  assert.equal(packed.text, "");

  const s2 = new ThinkingAccumulator();
  s2.push("");
  assert.equal(s2.hasContent, false);
});

test("outbound: thinking suppresses the error-text fallback", () => {
  const empty = new ThinkingAccumulator();
  assert.equal(empty.suppressesFallbackText, false, "无思维链时允许错误文案回落");
  empty.push("cot");
  assert.equal(empty.suppressesFallbackText, true, "有思维链时错误文案不得覆盖它");
});

test("text-block emission follows one rule: real text, or an empty content list", () => {
  const thinkingBlock = { type: "thinking", thinking: "c", signature: "s" };
  const toolBlock = { type: "tool_use", id: "t" };

  // 有有效正文 → 总是输出（即使已有其他块）
  assert.equal(shouldEmitTextBlock("hello", []), true);
  assert.equal(shouldEmitTextBlock("hello", [thinkingBlock]), true);
  assert.equal(shouldEmitTextBlock("  padded  ", [toolBlock]), true);

  // 正文为空但已有块 → 不补空气泡
  assert.equal(shouldEmitTextBlock("", [thinkingBlock]), false);
  assert.equal(shouldEmitTextBlock("   ", [toolBlock]), false);
  assert.equal(shouldEmitTextBlock(null, [thinkingBlock]), false);

  // 正文为空且无任何块 → 补占位，保证 content 永不为空数组
  assert.equal(shouldEmitTextBlock("", []), true);
  assert.equal(shouldEmitTextBlock("   ", []), true);
  assert.equal(shouldEmitTextBlock(undefined, []), true);
});

test("the two directions agree: a block the inbound side strips can be rebuilt outbound", () => {
  // 同一份思维链文本：入站被丢弃，出站可重建为带签名的块。
  const upstreamThinking = { type: "thinking", thinking: "reasoning", signature: "real" };
  assert.equal(shouldDiscardInboundThinking(upstreamThinking), true);

  const rebuilt = new ThinkingAccumulator().push(upstreamThinking.thinking).toAnthropicBlock();
  assert.equal(rebuilt.type, "thinking");
  assert.equal(rebuilt.thinking, upstreamThinking.thinking);
});
