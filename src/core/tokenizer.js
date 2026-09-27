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
export function estimateTokens(payload, options = {}) {
  if (!payload) return 0;
  if (typeof payload === "string") return Math.max(1, countTokens(payload));
  if (typeof payload !== "object") return 0;

  let totalChars = 0;
  let messageCount = 0;
  const parts = [];

  if (typeof payload.system === "string") {
    parts.push(payload.system);
    totalChars += payload.system.length;
  } else if (Array.isArray(payload.system)) {
    for (const part of payload.system) {
      if (typeof part?.text === "string") {
        parts.push(part.text);
        totalChars += part.text.length;
      }
    }
  }

  if (Array.isArray(payload.messages)) {
    messageCount = payload.messages.length;
    for (const m of payload.messages) {
      if (typeof m?.content === "string") {
        parts.push(m.content);
        totalChars += m.content.length;
      } else if (Array.isArray(m?.content)) {
        for (const p of m.content) {
          if (typeof p?.text === "string") {
            parts.push(p.text);
            totalChars += p.text.length;
          }
          if (typeof p?.content === "string") {
            parts.push(p.content);
            totalChars += p.content.length;
          }
        }
      }
    }
  }

  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    try {
      const toolsStr = JSON.stringify(payload.tools);
      parts.push(toolsStr);
      totalChars += toolsStr.length;
    } catch {
      // ignore serialization errors
    }
  }

  if (parts.length === 0) {
    try {
      const s = JSON.stringify(payload);
      parts.push(s);
      totalChars += s.length;
    } catch {
      return 0;
    }
  }

  // 协议级消息封装开销（每个 message 约 3-4 个元数据 token）
  const messageOverhead = messageCount > 0 ? messageCount * 3 + 3 : 0;

  // 热路径性能分流：超大 Payload（> 8000 字符，对应 > 2000 tokens）在主线程运行全量 BPE 分词
  // 会耗时数百毫秒并严重阻塞 Node 事件循环，导致请求在网关入口处排队超时。
  // 此时走极低 CPU 开销的加权估算（约 3.5 字符/token）；常规请求或显式 exact: true 走完整分词。
  if (!options?.exact && totalChars > 8000) {
    return Math.max(1, Math.ceil(totalChars / 3.5) + messageOverhead);
  }

  const text = parts.join(" ");
  const count = countTokens(text);
  return Math.max(1, count + messageOverhead);
}
