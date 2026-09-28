/**
 * Universal AI Gateway - DeepSeek Markup Language (DSML) Parser & Interceptor
 *
 * 专门防御与拦截 DeepSeek 系列大模型（V3 / V4）底层的原生工具调用标记语言（DSML）。
 * 当上游 API 服务商（如 WorkBuddy / 腾讯云等）在流式下发时漏解析 DSML、导致其作为
 * delta.content 普通文本泄漏时，本模块自动在网关转译层将其拦截并转化为标准的 Anthropic
 * tool_use 协议块，确保 Claude Code / Roo Code / Cline 等客户端无感、正常执行工具命令。
 */

import { syntheticCallId } from "./reduce.js";

// 匹配 DSML 标记前缀（支持半角 | 与全角 ｜，单重与双重管道符）
const DSML_PREFIX_REGEX = /<[｜|]{1,2}DSML[｜|]{1,2}/i;

/**
 * 快速检测文本是否包含 DSML 标记开始
 * @param {string} text
 * @returns {boolean}
 */
export function containsDsml(text) {
  if (typeof text !== "string") return false;
  return DSML_PREFIX_REGEX.test(text);
}

/**
 * 完整解析文本中包含的全部 DSML invoke 工具调用
 * @param {string} content
 * @returns {Array<{ name: string, args: Record<string, any> }>}
 */
// DSML 参数标签的正则（源串单点定义，调用处各自 new RegExp 以重置 lastIndex）。
//
// 此前该正则与下方的参数解析循环在 parseDsmlInvocations 与 DsmlStreamParser 里
// 逐字节重复两份 —— 协议事实写两遍就会静默漂移，故收敛为一份。
const PARAM_RE_SOURCE = String.raw`<[｜|]{1,2}DSML[｜|]{1,2}\s*parameter\s+name=["']([^"']+)["'](?:\s+string=["'](true|false)["'])?\s*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*parameter>`;

const INVOKE_RE_SOURCE = String.raw`<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*invoke>`;

// 解析一段 invoke 的 body，产出 args 对象。
// `string="false"` 走 JSON.parse 强转（数字/布尔/对象），失败则退回原字符串。
function parseDsmlParams(body) {
  const args = {};
  const re = new RegExp(PARAM_RE_SOURCE, "gi");
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].trim();
    const isString = m[2] !== "false";
    const raw = m[3];
    if (isString) {
      args[name] = raw;
    } else {
      try {
        args[name] = JSON.parse(raw.trim());
      } catch {
        args[name] = raw.trim();
      }
    }
  }
  return args;
}

export function parseDsmlInvocations(content) {
  if (typeof content !== "string" || !containsDsml(content)) return [];

  const invocations = [];
  const re = new RegExp(INVOKE_RE_SOURCE, "gi");
  let match;
  while ((match = re.exec(content)) !== null) {
    invocations.push({ name: match[1].trim(), args: parseDsmlParams(match[2]) });
  }
  return invocations;
}

/**
 * 清除文本中的全部 DSML 标记（包含 calls/tool_calls 外层包裹与独立 invoke 块），保留前后的正常说明文本
 * @param {string} content
 * @returns {string}
 */
export function stripDsml(content) {
  if (typeof content !== "string" || !containsDsml(content)) return content;

  // 1. 清理成对的外层 wrapper 及其内部所有内容
  let res = content.replace(/<[｜|]{1,2}DSML[｜|]{1,2}\s*(?:tool_calls|calls)>[\s\S]*?<\/[｜|]{1,2}DSML[｜|]{1,2}\s*(?:tool_calls|calls)>/gi, "");
  // 2. 清理未被外层包裹的独立 invoke 块
  res = res.replace(/<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name=["'][^"']+["']\s*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*invoke>/gi, "");
  // 3. 清理可能残留的孤立闭合标签
  res = res.replace(/<\/[｜|]{1,2}DSML[｜|]{1,2}\s*(?:tool_calls|calls|invoke)>/gi, "");

  // 4. 收敛因剔除标签导致的连续空行
  return res.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 流式增量 DSML 状态机解析器
 * 可以在逐 chunk 到达的流式场景下，实时切分普通正文与 DSML 工具块，并生成对应的规范事件。
 */
export class DsmlStreamParser {
  constructor() {
    this.buffer = "";
    this.inDsml = false;
  }

  /**
   * 推入一个文本 chunk，产出已就绪的事件列表
   * @param {string} chunk
   * @returns {Array<{ type: "text", text: string } | { type: "tool_use", id: string, name: string, args: Record<string, any> }>}
   */
  push(chunk) {
    if (!chunk) return [];
    this.buffer += chunk;
    const events = [];

    while (this.buffer.length > 0) {
      if (!this.inDsml) {
        // 查找 DSML 标签起始位
        const dsmlMatch = this.buffer.match(/<[｜|]{1,2}DSML[｜|]{1,2}/i);
        if (dsmlMatch) {
          const textBefore = this.buffer.slice(0, dsmlMatch.index);
          if (textBefore) {
            events.push({ type: "text", text: textBefore });
          }
          this.buffer = this.buffer.slice(dsmlMatch.index);
          this.inDsml = true;
          continue;
        }

        // 检查缓冲区尾部是否包含潜在的前缀片段（如 "<"、"<｜"、"<｜｜D" 等）
        const prefixMatch = this.buffer.match(/<[｜|]{0,2}D?S?M?L?[｜|]{0,2}$/i);
        if (prefixMatch && prefixMatch.index < this.buffer.length) {
          const textBefore = this.buffer.slice(0, prefixMatch.index);
          if (textBefore) {
            events.push({ type: "text", text: textBefore });
          }
          this.buffer = this.buffer.slice(prefixMatch.index);
          break; // 挂起，等待后续 chunk 判定是否为真实 DSML
        }

        // 既无 DSML 也无前缀悬挂：全部确认为普通正文放行
        events.push({ type: "text", text: this.buffer });
        this.buffer = "";
      } else {
        // 处于 DSML 解析模式下，清除开头的空白字符与换行
        if (/^\s+/.test(this.buffer)) {
          this.buffer = this.buffer.replace(/^\s+/, "");
        }
        if (this.buffer.length === 0) {
          break;
        }

        // 若开头是外层开标签 <...calls> 或 <...tool_calls>，直接剥离
        const openWrapper = this.buffer.match(/^<[｜|]{1,2}DSML[｜|]{1,2}\s*(?:tool_calls|calls)>/i);
        if (openWrapper) {
          this.buffer = this.buffer.slice(openWrapper[0].length);
          continue;
        }

        // 检查开头是否有完整的 invoke 块
        const invokeRegex = /^<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/[｜|]{1,2}DSML[｜|]{1,2}\s*invoke>/i;
        const invokeMatch = this.buffer.match(invokeRegex);
        if (invokeMatch) {
          const name = invokeMatch[1].trim();
          const args = parseDsmlParams(invokeMatch[2]); // 与 parseDsmlInvocations 同一实现

          events.push({
            type: "tool_use",
            id: syntheticCallId(),
            name,
            args
          });

          this.buffer = this.buffer.slice(invokeMatch[0].length);
          continue;
        }

        // 检查开头是否是外层闭标签 </...calls> 或 </...tool_calls>
        const closeWrapperMatch = this.buffer.match(/^<\/[｜|]{1,2}DSML[｜|]{1,2}\s*(?:tool_calls|calls)>/i);
        if (closeWrapperMatch) {
          this.buffer = this.buffer.slice(closeWrapperMatch[0].length);
          this.inDsml = false;
          continue;
        }

        // 若缓冲区头部仍有未闭合的 DSML 标签（如输入一半的 invoke 或 parameter），等待下一个 chunk
        if (/^<\/?\s*[｜|]{1,2}DSML/i.test(this.buffer) || /^<[｜|]{0,2}D?S?M?L?/i.test(this.buffer)) {
          break;
        }

        // 若缓冲区内还有后续的 DSML 标签，跳过标签间的非语法空白
        const nextTag = this.buffer.match(/<\/?\s*[｜|]{1,2}DSML/i);
        if (nextTag) {
          this.buffer = this.buffer.slice(nextTag.index);
          continue;
        }

        // 缓冲区已无任何 DSML 痕迹，退出 DSML 模式
        this.inDsml = false;
      }
    }

    return events;
  }

  /**
   * 流结束时冲洗缓冲区中残留的所有内容
   * @returns {Array<{ type: "text", text: string } | { type: "tool_use", id: string, name: string, args: Record<string, any> }>}
   */
  flush() {
    const events = [];
    if (this.buffer) {
      if (this.inDsml) {
        // 尝试抢救可能在流末尾未收到闭合标签但参数完整的 invoke
        const unclosedInvoke = this.buffer.match(/<[｜|]{1,2}DSML[｜|]{1,2}\s*invoke\s+name=["']([^"']+)["']\s*>([\s\S]*)/i);
        if (unclosedInvoke) {
          const name = unclosedInvoke[1].trim();
          const args = parseDsmlParams(unclosedInvoke[2]); // 与 parseDsmlInvocations 同一实现
          if (Object.keys(args).length > 0) {
            events.push({
              type: "tool_use",
              id: syntheticCallId(),
              name,
              args
            });
            this.buffer = "";
          }
        }
      }

      const remainingText = stripDsml(this.buffer);
      if (remainingText) {
        events.push({ type: "text", text: remainingText });
      }
      this.buffer = "";
    }
    return events;
  }
}
