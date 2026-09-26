// 思维链（thinking）—— 本概念的**唯一归属**。
//
// 此前该概念分散在四个模块，无一处拥有它，导致真正的约束只能写成注释：
//   - reasoning.js       —— 请求侧解析推理意图并注入 payload
//   - transform.js       —— 请求侧丢弃入站 thinking / redacted_thinking 块
//   - stream.js          —— 响应侧累积并重建 thinking 块（含流式 signature_delta）
//   - stream.js          —— 「何时输出 text 块」的规则
//
// 归属划分（诚实版）：
//   - 判据（何为 thinking）与出站签名、累积器、text 块规则归本模块；
//   - 拦截点的顺序（image 之后、text 之前）仍归 transform.js 的 if-else 链，
//     本模块只提供谓词，不拥有调用点的语句顺序。改动拦截顺序时两处同读。
//
// 两条铁律（由本模块集中守卫）：
//   1. 入站思维链**永不**上送上游——上游是 OpenAI 协议，不承载思维链。
//   2. 出站思维链必须带 signature，否则客户端会将其视为非法块。

/** 入站（Anthropic → OpenAI）需要拦截的思维链块类型。 */
const INBOUND_THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

/** 出站签名占位：上游不提供真实签名，Anthropic 客户端要求该字段非空。 */
export const SYNTHETIC_THINKING_SIGNATURE = "sig_synthetic_done";

/**
 * 该入站块是否为思维链块（入站方向唯一判据）。
 * @param {{type?: string}|null|undefined} block
 */
export function isInboundThinkingBlock(block) {
  return !!block && INBOUND_THINKING_TYPES.has(block.type);
}

/**
 * 入站思维链是否应被丢弃——恒为 true，但由本模块回答，
 * 使「上游不承载思维链」这条决策只有一个归属点。
 */
export function shouldDiscardInboundThinking(block) {
  return isInboundThinkingBlock(block);
}

/**
 * 出站（OpenAI 上游 → Anthropic 客户端）思维链累积器——非流式落袋用。
 * 流式路径用 StreamBlockState 逐帧发射（不经过本类）；两者共享签名常量与
 * 入站判据，不共享累积实现。统一的是「签名值与何时丢弃」，不是同一段拼接代码。
 */
export class ThinkingAccumulator {
  #text = "";

  /** 追加增量（流式 delta 或非流式整段 reasoning）。 */
  push(chunk) {
    if (typeof chunk === "string" && chunk) this.#text += chunk;
    return this;
  }

  /** 整段覆盖（非流式上游一次性给出完整 reasoning 时使用）。 */
  reset(text) {
    this.#text = typeof text === "string" ? text : "";
    return this;
  }

  get text() {
    return this.#text;
  }

  get hasContent() {
    return this.#text.length > 0;
  }

  /** 尚未成文的增量是否应抑制正文回退（错误文案不得覆盖思维链）。 */
  get suppressesFallbackText() {
    return this.#text.length > 0;
  }

  /**
   * 构造 Anthropic thinking 块；无内容时返回 null（调用方据此跳过）。
   * signature 由本模块统一补齐——出站思维链缺签名即为非法块。
   */
  toAnthropicBlock() {
    if (!this.hasContent) return null;
    return {
      type: "thinking",
      thinking: this.#text,
      signature: SYNTHETIC_THINKING_SIGNATURE
    };
  }

  /** 本思维链是否应参与输出 token 估算与 stop 判定文本。 */
  estimatedChars() {
    return this.#text.length;
  }
}

/**
 * 响应侧「何时输出 text 块」的唯一规则（此前散在 stream.js:1029 的注释里）。
 *
 * 有有效正文时当然输出；正文为空且**已有 thinking 或 tool_use 块**时不补空气泡
 * （空 text 块既无信息量，又会被部分上游判为非法请求）；否则补一个占位正文，
 * 保证 content 永不为空数组。
 *
 * @param {string} text - 已累积的正文（未 trim）
 * @param {Array<object>} blocks - 已生成的内容块
 * @returns {boolean} 是否追加 text 块
 */
export function shouldEmitTextBlock(text, blocks) {
  if (typeof text === "string" && text.trim()) return true;
  return blocks.length === 0;
}
