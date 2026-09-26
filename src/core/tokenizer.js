// Token 估算器 —— 基于 gpt-tokenizer (GPT-4o BPE 字典) 的精确分词
import { countTokens as bpeCount } from "gpt-tokenizer/model/gpt-4o";

/**
 * 字符串 Token 计数（基于 gpt-4o BPE 字典）
 * @param {string} text - 待分词文本
 * @returns {number}
 */
export function countTokens(text) {
  if (!text || typeof text !== "string") return 0;
  return bpeCount(text);
}

/**
 * 统一 Token 估算：支持字符串、Anthropic/OpenAI 消息数组或整个请求 Payload
 *
 * @param {string|object} payload - 待估算对象
 * @returns {number} token 计数
 */
export function estimateTokens(payload) {
  if (!payload) return 0;
  let text = "";
  let messageCount = 0;

  if (typeof payload === "string") {
    text = payload;
  } else if (typeof payload === "object") {
    if (typeof payload.system === "string") {
      text += payload.system + " ";
    } else if (Array.isArray(payload.system)) {
      for (const part of payload.system) {
        if (typeof part?.text === "string") text += part.text + " ";
      }
    }

    if (Array.isArray(payload.messages)) {
      messageCount = payload.messages.length;
      for (const m of payload.messages) {
        if (typeof m?.content === "string") {
          text += m.content + " ";
        } else if (Array.isArray(m?.content)) {
          for (const p of m.content) {
            if (typeof p?.text === "string") text += p.text + " ";
            if (typeof p?.content === "string") text += p.content + " ";
          }
        }
      }
    }

    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      try {
        text += JSON.stringify(payload.tools) + " ";
      } catch {
        // ignore serialization errors
      }
    }

    if (!text) {
      try {
        text = JSON.stringify(payload);
      } catch {
        text = "";
      }
    }
  }

  // 协议级消息封装开销（每个 message 约 3-4 个元数据 token）
  const messageOverhead = messageCount > 0 ? messageCount * 3 + 3 : 0;
  const count = countTokens(text);
  return Math.max(1, count + messageOverhead);
}
