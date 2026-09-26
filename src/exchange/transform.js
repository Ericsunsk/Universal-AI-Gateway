// 请求侧转译 —— Anthropic ⇄ OpenAI 的请求体映射（transform / normalize / prune）。
// 纯数据变换，无 I/O；响应侧与路由见 ./stream.js 与 ./dispatch.js。
import { optimizeToolOutput } from "./sanitizer.js";
import { parseReasoningIntent, applyReasoningToPayload } from "./reasoning.js";
import { parseMaxContextTurns } from "../config/config.js";

/**
 * 归一化 Anthropic stop_sequences → 可安全下发给上游的 stop 数组。
 * 唯一口径：transform 注入 payload.stop 与 dispatch 传给流式层的判定序列共用此函数，
 * 避免「实际发给上游的序列」与「响应侧用于判定 stop_reason 的序列」出现分歧
 * （分歧会导致检测到一条从未下发过的序列，或漏检真正下发过的）。
 *
 * - 逐项过滤：空串 / 纯空白会被 OpenAI 及多数兼容上游判为 400 invalid_request
 * - 截断到 4 条：上游普遍上限，超出截断而非报错（Anthropic 侧上限同为 4）
 *
 * @param {unknown} raw - body.stop_sequences
 * @returns {string[]} 归一化后的序列（可能为空数组）
 */
export function normalizeStopSequences(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(s => typeof s === "string" && s.trim().length > 0)
    .slice(0, 4);
}

// tool_result 单块展平为 string 的唯一口径：string / text 块 / 其余 JSON.stringify。
// toolResultBlockText（整体）与 toolResultSplit（逐块，图片另走）共用，不再各写一份。
function toolResultChunkText(c) {
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && c.text) return c.text;
  return JSON.stringify(c);
}

// tool_result 内容展平为 string：string / 文本块数组 / 任意对象统一口径。
// normalize 孤儿包、Anthropic→OpenAI 映射、prune 三处共用，不再各写一遍。
export function toolResultBlockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(toolResultChunkText).join("\n");
  }
  return JSON.stringify(content ?? "");
}

// Anthropic image 块 -> OpenAI image_url part（唯一映射点，别处不再各写一份）：
//   - source.type "base64" → data URI（media_type 按 Anthropic 规范必填，缺失不猜、直接 400）
//   - source.type "url"    → 原样透传（由上游去取，本仓库不 fetch，故不套 providers/urlGuard）
// 非法 source 属客户端错误：抛 400 让 dispatch short-circuit，既不静默丢图也不进故障转移。
export function imageBlockToImagePart(block) {
  const fail = (why) => {
    const err = new Error(`Invalid image block: ${why}`);
    err.status = 400;
    throw err;
  };
  const src = block?.source;
  if (!src || typeof src !== "object") fail("image.source must be an object");
  if (src.type === "base64") {
    if (typeof src.media_type !== "string" || !src.media_type) fail("image.source.media_type must be a string");
    if (typeof src.data !== "string" || !src.data) fail("image.source.data must be a base64 string");
    return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  if (src.type === "url") {
    if (typeof src.url !== "string" || !src.url) fail("image.source.url must be a string");
    return { type: "image_url", image_url: { url: src.url } };
  }
  fail(`image.source.type must be "base64" or "url" (got ${JSON.stringify(src.type ?? null)})`);
}

// tool_result 内容拆成「文本」+「图片 parts」：OpenAI 的 tool 消息 content 只能是文本，
// 若按 toolResultBlockText 整体序列化，工具返回的截图（Claude Code Read 图片正是这条路径）
// 会把几 MB base64 当成 JSON 灌进 token。图片由此抽出，由调用方作为紧随的 user 消息发出。
// 文本口径复用 toolResultChunkText，与 toolResultBlockText 逐块一致。
export function toolResultSplit(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (Array.isArray(content)) {
    const texts = [];
    const images = [];
    for (const c of content) {
      if (c && typeof c === "object" && c.type === "image") {
        images.push(imageBlockToImagePart(c));
      } else {
        texts.push(toolResultChunkText(c));
      }
    }
    return { text: texts.join("\n"), images };
  }
  return { text: JSON.stringify(content ?? ""), images: [] };
}

// 含图片的普通消息：按原序编排为 OpenAI 多模态 parts（text + image_url）。
// tool_use / tool_result 不进 parts（各自分支已发为独立消息）；图片用已映射的 imageParts
// 按出现顺序取用，保证文本与图片的相对顺序与 Anthropic 请求体一致。
function buildOpenAIContentParts(content, imageParts) {
  const parts = [];
  let imgIdx = 0;
  for (const b of content) {
    if (!b) continue;
    if (b.type === "image") {
      const part = imageParts[imgIdx++];
      if (part) parts.push(part);
    } else if (b.type !== "tool_use" && b.type !== "tool_result") {
      parts.push({ type: "text", text: typeof b.text === "string" ? b.text : "" });
    }
  }
  return parts;
}

// assistant 消息携带 image 块属于协议外输入（Anthropic 只允许 user 发图）。
// OpenAI 方言的 assistant 消息也放不下图片 part —— 若默默丢弃，客户端会以为图已送达。
// 与「本仓库不静默丢图」的原则一致：这里显式 400 让客户端可归因。
function assertNoAssistantImages(role, content) {
  if (role !== "assistant" || !Array.isArray(content)) return;
  if (!content.some(b => b && b.type === "image")) return;
  const err = new Error("image blocks are not allowed in assistant messages");
  err.status = 400;
  throw err;
}

// OpenAI 消息序列的唯一排序主人（ordering seam）：上游 11148 要求
// assistant tool_calls → tool 结果紧随 → 附带图片的 user 消息最后。
// 此前 fan-out（tool 结果展开 + 尾随图片补发）与 re-sort（tool 结果重挂）
// 是三个平级 helper，11148 恰恰坏在它们之间的顺序上，且无单个测试覆盖交错。
// 新调用方只经由本类追加完整 tool 交换（appendToolExchange）并以 finalize()
// 收尾，排序不变量收敛在一处，单测只须面对这一个面。
export class OpenAIMessageSequence {
  constructor(initialMessages = []) {
    this._messages = [...initialMessages];
  }

  push(message) {
    this._messages.push(message);
    return this;
  }

  // 原子追加一次 tool 交换：assistant（含 tool_calls，可选）→ companion
  // tool 结果（纯文本，图片另走）→ 尾随图片 user 消息（若有，必在交换之末）。
  // 调用方不再分两次调用 fan-out + 补图，交错顺序在本方法内一次写死。
  appendToolExchange({ assistantMessage = null, toolResultBlocks = [], imageParts = [] } = {}) {
    if (assistantMessage) this._messages.push(assistantMessage);
    const toolImages = this.#pushToolResults(toolResultBlocks);
    this.#pushTrailingImages(imageParts, toolImages);
    return this;
  }

  // 11148 收尾：tool 结果挂载到其 assistant tool_calls 正下方，图片 user
  // 消息保持在交换之末（见 sortToolSequence）。
  finalize() {
    return sortToolSequence(this._messages);
  }

  // tool_result 块组 → OpenAI tool 消息，返回其中抽出的图片 parts。
  // tool 消息 content 只能是文本，图片放不进去（整体序列化会把 base64 灌进 token），
  // 因此这里只发文本，图片交 #pushTrailingImages 补发。
  // tool_use_id 缺失在这里统一 400（原本两个分支各校验一次）。
  #pushToolResults(toolResultBlocks) {
    const images = [];
    for (const rb of toolResultBlocks) {
      if (!rb.tool_use_id) {
        const err = new Error("tool_result block is missing tool_use_id");
        err.status = 400;
        throw err;
      }
      const split = toolResultSplit(rb.content);
      for (const p of split.images) images.push(p);
      this._messages.push({
        role: "tool",
        tool_call_id: rb.tool_use_id,
        content: split.text
      });
    }
    return images;
  }

  // 图片统一以紧随其后的 user 多模态消息补发：OpenAI 要求 tool 消息紧跟 assistant tool_calls，
  // 图片插在中间会打断工具调用序列（上游 11148）；tool 消息自身又装不下图片。
  // 调用方不得单独调用——顺序由 appendToolExchange 保证（图片必在 tool 结果之后）。
  #pushTrailingImages(imageParts, toolImages) {
    const images = toolImages.length > 0 ? [...imageParts, ...toolImages] : imageParts;
    if (images.length === 0) return;
    this._messages.push({ role: "user", content: images });
  }
}

// /compact 总结请求的意图标记：Anthropic 形（body.system + 末条文本）与 OpenAI 形
//（messages[0] system + 末条）两处探测共用同一标记表，不再各写一份。
const COMPACT_MARKERS = ["Respond with TEXT ONLY", "<analysis>", "<summary>", "Do NOT use Read, Bash, Grep"];

function containsCompactMarker(text) {
  return typeof text === "string" && text !== "" && COMPACT_MARKERS.some(m => text.includes(m));
}

// 消息内容展平为文本（compact 探测用）：string / 文本块数组统一口径。
function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(c => typeof c === "string" ? c : (c?.text || "")).join(" ");
  return "";
}

// 回合数归一化统一走 config.js parseMaxContextTurns（KV 存量可能绕过 getDefaultConfig，
// 消费侧必须用同一口径兜底；此前本地 normalizeTurns 用 Number，与 parseInt 语义分叉）。

// 内部协议工具：Tools 转换
export function transformToolsToOpenAI(tools) {  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} }
    }
  }));
}

// 核心状态机规范化本体（原 normalizeOpenAIMessages，原样下沉）：重构并对齐
// OpenAI tool_calls 与 tool_results 顺序（根除 11148 tool_call_sequence_broken）。
// 唯一调用方是 OpenAIMessageSequence.finalize() 与下方同名导出包装，
// 不再有游离的直接调用——重挂顺序是序列模块的内部事务。
function sortToolSequence(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const toolResultsMap = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.tool_call_id) {
      toolResultsMap.set(m.tool_call_id, m);
    }
  }

  const result = [];
  const seenToolResultIds = new Set();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") {
      // 若该 tool 结果已被挂载在其对应的 assistant tool_calls 之后，则跳过
      if (seenToolResultIds.has(m.tool_call_id)) continue;
      // 孤儿 tool 结果（前置无对应 assistant tool_calls），降级为 user 消息避免上游 11148 序列破坏
      result.push({
        role: "user",
        content: `[Tool Result: ${toolResultBlockText(m.content)}]`
      });
      continue;
    }

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      result.push(m);
      // 强制将所有匹配的 tool_result 紧跟在当前的 assistant tool_calls 之后
      for (let j = 0; j < m.tool_calls.length; j++) {
        const tc = m.tool_calls[j];
        if (toolResultsMap.has(tc.id)) {
          result.push(toolResultsMap.get(tc.id));
          seenToolResultIds.add(tc.id);
        } else {
          // 缺失结果的孤儿 tool_call（如用户取消、中断或超时），补充合成结果闭环状态机
          result.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "[Result omitted or operation cancelled]"
          });
        }
      }
      continue;
    }

    result.push(m);
  }

  return result;
}

// 导出包装（行为兼容：dispatch.js OpenAI 直传路径与既有测试依赖它）。
// 排序本体已收归序列模块内部（sortToolSequence），此处只做一层转发，
// 保证游离调用与序列收尾走同一口径。
export function normalizeOpenAIMessages(messages) {
  return sortToolSequence(messages);
}

/**
 * 智能上下文窗口剪枝与管理：
 * 1. 根治超长会话（如 Claude Code 累积数十上百轮、上千条消息）触发边缘运行时 CPU/内存上限导致的致命错误。
 * 2. 对长会话智能截取“首轮任务意图 + 最近活跃上下文”，并严格保证切片位于干净的 user 轮次，避免工具调用序列破坏 (11148)。
 * 3. 对历史工具执行结果（tool_result）的大块冗余终端输出进行两端保留式剪枝。
 */
function pruneMessageContents(messages, isCompact) {
  const total = messages.length;
  return messages.map((msg, idx) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const turnAge = total - idx;
    let modified = false;
    const newContent = msg.content.map(part => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "tool_result") {
        // 含图片块的 tool_result 绝不整体序列化：base64 会被当文本清洗/折叠，图片永久降级成 JSON 垃圾。
        // 改为逐块处理——文本块照常 optimize，图片块原样保留（真正的映射在 transformAnthropicToOpenAI）。
        if (Array.isArray(part.content) && part.content.some(c => c && typeof c === "object" && c.type === "image")) {
          let innerModified = false;
          const inner = part.content.map(c => {
            if (typeof c === "string") {
              const optimized = optimizeToolOutput(c, turnAge, isCompact);
              if (optimized !== c) { innerModified = true; return optimized; }
              return c;
            }
            if (c && typeof c === "object" && c.type !== "image" && typeof c.text === "string") {
              const optimized = optimizeToolOutput(c.text, turnAge, isCompact);
              if (optimized !== c.text) { innerModified = true; return { ...c, text: optimized }; }
              return c;
            }
            return c; // image 块与未知块原样保留
          });
          if (innerModified) modified = true;
          return innerModified ? { ...part, content: inner } : part;
        }
        const text = toolResultBlockText(part.content);
        const optimized = optimizeToolOutput(text, turnAge, isCompact);
        if (optimized !== text) {
          modified = true;
          return { ...part, content: optimized };
        }
      }
      return part;
    });
    return modified ? { ...msg, content: newContent } : msg;
  });
}

/**
 * OpenAI 协议路径的 compact 意图检测：与 Anthropic 路径同 markers（/compact 总结请求），
 * 只是 shape 不同（system 在 messages[0]，lastText 在末条 user）。供 dispatch OpenAI 直传路径
 * 调用，避免此前硬编码 false 导致 compact 截断分支永不生效。
 */
export function isCompactOpenAIRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const first = messages[0];
  const sysText = first?.role === "system" ? blockText(first.content) : "";
  const lastText = blockText(messages[messages.length - 1]?.content);
  return containsCompactMarker(sysText) || containsCompactMarker(lastText);
}

/**
 * OpenAI 协议路径的工具输出优化：OpenAI 方言里工具结果就是 `{role:"tool", content:<string>}`，
 * 与 Anthropic 的 tool_result 块语义一致。此前只有 Anthropic 路径经过 optimizeToolOutput，
 * 走 /v1/chat/completions 的客户端完全没有 Token 优化。这里补齐：max_context_turns<=0（默认全量保真）
 * 时仍执行无损清洗（ANSI/分隔符/空行），turnAge 有界，最新回合始终全保真，不改变历史裁剪语义。
 */
export function pruneOpenAIMessages(messages, isCompact = false) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const total = messages.length;
  let anyModified = false;
  const result = messages.map((msg, idx) => {
    // 仅处理 OpenAI 工具结果消息，其余（user/assistant/system）一律原样保留
    if (!msg || typeof msg !== "object" || msg.role !== "tool") return msg;
    if (typeof msg.content !== "string") return msg;

    // turnAge 与 pruneMessageContents 完全一致：越靠前的消息年龄越大
    const turnAge = total - idx;
    const optimized = optimizeToolOutput(msg.content, turnAge, isCompact);
    // 无变化时保持对象同一性，避免下游无谓重建
    if (optimized === msg.content) return msg;
    anyModified = true;
    return { ...msg, content: optimized };
  });

  return anyModified ? result : messages;
}

function pruneAnthropicMessages(messages, isCompact, maxTurnsLimit = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // 当 maxTurnsLimit <= 0 时，保留全部会话轮次，但仍执行工具结果清洗（RTK 式 Token 压缩、测试成功项折叠与渐进式退火）
  if (maxTurnsLimit <= 0) {
    return pruneMessageContents(messages, isCompact);
  }

  const total = messages.length;
  const maxWindow = isCompact ? Math.max(maxTurnsLimit * 1.5, 70) : maxTurnsLimit;
  if (total <= maxWindow) return pruneMessageContents(messages, isCompact);

  let cutIdx = Math.max(1, total - maxWindow);
  while (cutIdx < total - 5) {
    const m = messages[cutIdx];
    const isToolResult = m && m.role === "user" && Array.isArray(m.content) && m.content.some(c => c && c.type === "tool_result");
    if (!isToolResult) break;
    cutIdx++;
  }

  const firstMsg = messages[0];
  const recentMsgs = messages.slice(cutIdx);
  const truncatedCount = cutIdx - 1;
  const firstRecent = recentMsgs[0];
  const bridgeMsg = firstRecent && firstRecent.role === "assistant"
    ? { role: "user", content: `[System Notice: Earlier conversation (${truncatedCount} messages) omitted to preserve context and latency limits. Resuming from active context.]` }
    : { role: "assistant", content: `[System Notice: Earlier conversation (${truncatedCount} messages) omitted to preserve context and latency limits. Ready for next step.]` };

  return pruneMessageContents([firstMsg, bridgeMsg, ...recentMsgs], isCompact);
}

// 内部协议工具：Anthropic 请求体 -> OpenAI 请求体
// intent 由 dispatch 预解析后传入（一请求只解析一次）；直接调用时传 null 自行解析。
export function transformAnthropicToOpenAI(body, targetModel, config = {}, intent = null) {
  const model = targetModel || body.model || "deepseek-v4.1-flash";
  // 输出经由 OpenAIMessageSequence 累积：tool 交换的 fan-out 与 11148
  // 重挂是序列模块的内部事务，本函数只追加完整交换并以 finalize() 收尾。
  const sequence = new OpenAIMessageSequence();

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const totalMessages = rawMessages.length;
  const lastMsg = totalMessages > 0 ? rawMessages[totalMessages - 1] : null;
  const lastText = blockText(lastMsg?.content);

  // 检测是否为会话压缩 / 总结请求（如 Claude Code /compact），与 OpenAI 形探测同标记表
  const isCompact = (typeof body.system === "string" && containsCompactMarker(body.system)) ||
    containsCompactMarker(lastText);

  // 动态上下文保留策略：Vercel / Node 环境下默认 0（完全不剪枝，长上下文全量保真）
  const maxTurns = parseMaxContextTurns(
    config?.max_context_turns !== undefined
      ? config.max_context_turns
      : (typeof process !== "undefined" && process.env?.MAX_CONTEXT_TURNS !== undefined
          ? process.env.MAX_CONTEXT_TURNS
          : 0)
  );

  const messages = pruneAnthropicMessages(rawMessages, isCompact, maxTurns);

  if (body.system) {
    if (typeof body.system === "string") {
      sequence.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      // Validate that each element in system array is an object with text property
      const systemTexts = [];
      for (let i = 0; i < body.system.length; i++) {
        const sysBlock = body.system[i];
        if (!sysBlock || typeof sysBlock !== "object") {
          const err = new Error(`system[${i}] must be an object`);
          err.status = 400;
          throw err;
        }
        if (typeof sysBlock.text !== "string") {
          const err = new Error(`system[${i}].text must be a string`);
          err.status = 400;
          throw err;
        }
        systemTexts.push(sysBlock.text);
      }
      sequence.push({ role: "system", content: systemTexts.join("\n") });
    } else {
      sequence.push({ role: "system", content: String(body.system) });
    }
  }

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (!msg) continue;
    assertNoAssistantImages(msg.role, msg.content);

    if (typeof msg.content === "string") {
      sequence.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      });
    } else if (Array.isArray(msg.content)) {
      const toolUseBlocks = [];
      const toolResultBlocks = [];
      const textBlocks = [];
      // 本消息内抽出的图片（含 tool_result 内嵌图片），保持出现顺序
      const imageParts = [];

      for (let i = 0; i < msg.content.length; i++) {
        const b = msg.content[i];
        if (!b) continue;
        if (b.type === "tool_use") toolUseBlocks.push(b);
        else if (b.type === "tool_result") toolResultBlocks.push(b);
        else if (b.type === "image") imageParts.push(imageBlockToImagePart(b));
        // thinking / redacted_thinking 显式丢弃：上游为 OpenAI 协议，不承载思维链。
        // 二者的载荷字段是 thinking（非 text），若落入 textBlocks 会抽出空串——
        // 轻则产出 content:"" 的空气泡消息，重则与同消息正文拼接，把思维链当正文喂给上游。
        // 注意必须在 image 之后、textBlocks 之前拦截，不得并入 text。
        else if (b.type === "thinking" || b.type === "redacted_thinking") continue;
        else textBlocks.push(b);
      }

      if (msg.role === "assistant" && toolUseBlocks.length > 0) {
        let textContent = null;
        if (textBlocks.length === 1) {
          textContent = textBlocks[0].text || null;
        } else if (textBlocks.length > 1) {
          textContent = textBlocks.map(b => b.text || "").join("\n");
        }

        const toolCalls = toolUseBlocks.map(tb => ({
          id: tb.id,
          type: "function",
          function: {
            name: tb.name,
            arguments: typeof tb.input === "string" ? tb.input : JSON.stringify(tb.input || {})
          }
        }));
        // 同消息的 tool_result companion 不丢弃：整段 tool 交换一次追加，
        // assistant → tool 结果 → 尾随图片的顺序由序列模块锁定。
        sequence.appendToolExchange({
          assistantMessage: {
            role: "assistant",
            content: textContent,
            tool_calls: toolCalls
          },
          toolResultBlocks,
          imageParts
        });
      } else if (toolResultBlocks.length > 0) {
        // 同消息的 text companion 不丢弃：先发文本再发 tool 结果。
        if (textBlocks.length > 0) {
          const combined = textBlocks.map(b => b.text || "").join("\n");
          if (combined) {
            sequence.push({
              role: msg.role === "assistant" ? "assistant" : "user",
              content: combined
            });
          }
        }
        sequence.appendToolExchange({ toolResultBlocks, imageParts });
      } else {
        let combined = "";
        if (textBlocks.length === 1) {
          combined = textBlocks[0].text || "";
        } else if (textBlocks.length > 1) {
          combined = textBlocks.map(b => b.text || "").join("\n");
        }
        // 纯 thinking 消息（丢弃后已无任何可发内容且无图片）整体跳过：
        // 发 content:"" 的空气泡既无信息量，又会被部分上游判为非法请求。
        if (!combined && imageParts.length === 0) continue;
        sequence.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          // 无图片时保持 string content（与历史输出逐字节一致）；含图片才切成多模态 parts
          content: imageParts.length > 0 ? buildOpenAIContentParts(msg.content, imageParts) : combined
        });
      }
    }
  }

  // 若为总结压缩请求，剥离 tools 定义避免上游大模型生成 tool_calls 反射
  const upstreamTools = isCompact ? undefined : transformToolsToOpenAI(body.tools);
  const payload = {
    model: model,
    messages: sequence.finalize(),
    stream: body.stream !== false
  };

  if (upstreamTools && upstreamTools.length > 0) {
    payload.tools = upstreamTools;
    payload.tool_choice = "auto";
  }

  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  // Anthropic stop_sequences → OpenAI stop。不透传的话客户端设的停止序列完全失效。
  const stops = normalizeStopSequences(body.stop_sequences);
  if (stops.length > 0) payload.stop = stops;
  if (body.top_p !== undefined) payload.top_p = body.top_p;

  // 共享思维链与推理强度调度器：统一解析与注入
  const reasoningIntent = intent || parseReasoningIntent({ model: body.model || model, body });
  applyReasoningToPayload(payload, reasoningIntent, "openai", targetModel || model);

  return payload;
}
