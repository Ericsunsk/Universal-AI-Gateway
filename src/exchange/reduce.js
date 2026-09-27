// Reduce 层 —— OpenAI chunk/JSON → Anthropic 语义的纯归约，无任何 I/O。
//
// 从 stream.js 抽出（见该文件顶注）：本文件只做分类、字段提取与块状态机，
// 所有 *Frame() 方法返回待写出的帧字符串，由调用方负责 write()。
// 因此可脱离网络与流做纯单测——这是响应侧最易回归、也最该被测试的部分。
//
// 依赖方向：reduce.js ← stream.js（单向）。本文件不得引入 writer / Response / corsHeaders；
// 唯一例外是 iterSseParsedChunks：它读上游 reader 并复用 eventsource-parser，
// 但从不写回客户端，故仍属归约侧（其顶注自称 parsed-chunk 接缝）。
import { createParser } from "eventsource-parser";
import { SYNTHETIC_THINKING_SIGNATURE } from "./thinking.js";
import { log } from "../logging/logger.js";

// 纯函数：把单个已解析的 OpenAI SSE chunk 归约为一条「发射指令」。
// 不做任何 I/O，只做分类与字段提取 —— 这是流式转译里最易回归、也最该被测试的部分。
// 返回 null 表示该 chunk 无需发射任何事件（如空 delta、[DONE] 已在外层过滤）。
// 可能的 kind:
//   "error"    —— 上游业务错误/非零 code，应降级为 notice 文本
//   "thinking" —— DeepSeek reasoning_content 思维链增量
//   "text"     —— 正文文本增量
//   "tool_use" —— 工具调用块（可能伴随 id/name/arguments）
// 纯函数：从已解析的上游 JSON 中提取错误消息（error 字段 / msg / message / 非零 code）。
// reduceOpenAIChunkAll 与非流式落袋共享，避免两处各自拼装。
export function extractErrorMessage(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  return parsed.error?.message || parsed.msg || parsed.message ||
    (parsed.code !== undefined && parsed.code !== 0 ? `Upstream error code ${parsed.code}` : null);
}

// 纯函数：判断上游是否携带业务错误（Tencent code !== 0 或显式 error 字段）。
export function isUpstreamError(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  return !!(parsed.error || (parsed.code !== undefined && parsed.code !== 0));
}

// 纯函数：从已解析的 usage 中提取 token 计数，返回 { input, output }（缺失保留原值）。
// 默认回退为 0（未知即 0，不伪造）：调用方在已知上下文中显式传入估算值。
export function extractUsage(parsed, current = { input: 0, output: 0 }) {
  const u = parsed?.usage;
  if (!u) return current;
  return {
    input: u.prompt_tokens || current.input,
    output: u.completion_tokens || current.output
  };
}

// 纯函数：提取上游前缀缓存命中 token 数（OpenAI 形 cached_tokens / Anthropic 形
// cache_read_input_tokens），缺失为 0。调用方取各 chunk 最大值记一次。
export function extractCachedTokens(parsed) {
  const u = parsed?.usage;
  if (!u || typeof u !== "object") return 0;
  const n = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0;
}

/**
 * 停止序列这一概念的**唯一归属**。
 *
 * 调用方只持有本值的两个字段，不再自行推导「序列是否生效」：
 * 归一化（去空、去非字符串、去重）与「正文命中哪一条」的查找都在此实现，
 *   - `sequences` —— 归一化后的有效序列（无效项已被剔除）
 *   - `active`    —— 是否真的下发了至少一条有效序列。这是**普通布尔**，
 *                    不会出现 `undefined`；调用方无需再判类型或长度
 *
 * 取代此前散落各处的 `Array.isArray(x) && x.length > 0` 重复判定，
 * 以及 resolveStopDetails 内「解构默认 false、却又用 !== undefined 判定」的三态歧义。
 *
 * @param {unknown} raw - 请求侧下发的原始 stop_sequences（任意形状，函数自行容错）
 */
export function resolveStopDetail(raw) {
  const sequences = Array.isArray(raw)
    ? [...new Set(raw.filter(s => typeof s === "string" && s.length > 0))]
    : [];
  return {
    sequences,
    active: sequences.length > 0,
    /**
     * 正文是否命中某条下发序列（按下发顺序取首条命中）。
     * @param {string} text
     * @returns {string|null}
     */
    match(text) {
      if (!sequences.length || typeof text !== "string" || !text) return null;
      return sequences.find(s => text.includes(s)) ?? null;
    }
  };
}

/**
 * 统一解析终局 stop_reason 与 stop_sequence。
 * 流式与非流式转译共享此唯一口径，避免逻辑分歧与重复代码。
 *
 * 映射规则：
 * - "length" → stop_reason: "max_tokens", stop_sequence: null
 * - "tool_calls" / "function_call" / "tool_use" → stop_reason: "tool_use", stop_sequence: null
 * - "stop_sequence" → 上游明确返回命中停止序列（Anthropic/vLLM/LiteLLM 等）：
 *   若正文命中某条序列则回显该序列；否则取下发的首条序列（或 null）
 * - "stop" → OpenAI 上游在自然停止与命中停止序列时均返回 "stop"：
 *   若下发过停止序列且在正文尾部探测到命中，判定为 "stop_sequence" 并附带该序列；
 *   否则一律收敛为 "end_turn", stop_sequence: null
 * - 其余 (content_filter / null / 未知) → stop_reason: "end_turn", stop_sequence: null
 *
 * @param {string|null} finishReason - 上游 finish_reason 或 blockState.stopReason
 * @param {object} options
 * @param {string} [options.text=""] - 用于尾部命中的正文
 * @param {Array<object>|null} [options.candidates=[]] - 本次故障转移尝试过的候选快照，
 *   每条带 provider/model/step（step = 该候选链内的第几次重试）。仅用于错误归因。
 * @param {object} [options.detail] - 已解析的 stop-detail（resolveStopDetail 的返回值）。
 *   **省略时**由本函数从 `options.stopSequences` 就地解析，使既有调用点零改动。
 * @param {unknown} [options.stopSequences] - 原始序列；仅当 detail 省略时使用。
 * @returns {{stopReason: string, stopSequence: string|null}}
 */
export function resolveStopDetails(finishReason, { text = "", detail, stopSequences } = {}) {
  // 兼容口径：detail 优先；未给则从原始 stopSequences 就地解析（不再接受 hasStopSequences）。
  const d = detail ?? resolveStopDetail(stopSequences);
  switch (finishReason) {
    case "length":
      return { stopReason: "max_tokens", stopSequence: null };
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return { stopReason: "tool_use", stopSequence: null };
    case "stop_sequence":
      return {
        stopReason: "stop_sequence",
        stopSequence: d.match(text) || (d.active ? d.sequences[0] : null)
      };
    case "stop": {
      // 「是否生效」由 detail 唯一回答，不再有 unset/false/[] 三态。
      if (d.active) {
        const hit = d.match(text);
        if (hit) return { stopReason: "stop_sequence", stopSequence: hit };
      }
      return { stopReason: "end_turn", stopSequence: null };
    }
    case "content_filter":
    default:
      return { stopReason: "end_turn", stopSequence: null };
  }
}

export function finishReasonToAnthropic(finishReason, opts = {}) {
  return resolveStopDetails(finishReason, opts).stopReason;
}

// 纯函数：把单个已解析的 OpenAI SSE chunk 归约为一组「发射指令」（按发射顺序排列）。
// 取代单发射 reducer：同一 chunk 可同时携带 thinking + text + tool_calls，单发射按优先级
// 会吞掉后者。两条消费路径（流式 / 非流式）都遍历数组，不再各写一遍字段读取。
// emission 种类（error 独占；其余按 thinking → text → tool_use → finish 顺序排列）：
//   "error"    —— 上游业务错误/非零 code（同 chunk 其他字段忽略）
//   "thinking" —— { text } 思维链增量
//   "text"     —— { text } 正文增量
//   "tool_use" —— { calls: [{ id, name, args, ident }], stopReason }，ident 标记该 call
//                 是否自带 id/name（无身份的纯 argument 碎片由消费方决定去留）
//   "finish"   —— { finishReason } 上游原始值，由消费方决定是否采用
// 无 delta 且无 error 的 chunk（如纯 finish 标记）返回 []。
export function reduceOpenAIChunkAll(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  if (isUpstreamError(parsed)) {
    return [{ kind: "error", message: extractErrorMessage(parsed) || "Unknown error" }];
  }
  const delta = parsed.choices?.[0]?.delta;
  const finishReason = parsed.choices?.[0]?.finish_reason;
  const out = [];
  // 终局 finish_reason 可能不带 delta（如纯 stop 标记）：先收 finish，再判 delta。
  const hasFinish = !!finishReason;
  if (!delta && !hasFinish) return [];
  // 思维链增量（兼容 DeepSeek 的 reasoning_content 与通用 reasoning 字段）
  const reasoningDelta = delta?.reasoning_content || delta?.reasoning;
  if (reasoningDelta) out.push({ kind: "thinking", text: reasoningDelta });
  // 正文增量
  if (delta?.content) out.push({ kind: "text", text: delta.content });
  // 工具调用：同一 chunk 内可能携带多个 tool_call
  // index 必须透出：稀疏分片（每 chunk 只带一个 index）下，合并方需按 index 定址，
  // 不能按 chunk 内序号 ci 推断，否则并行调用的碎片会交叉污染。
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    out.push({
      kind: "tool_use",
      calls: delta.tool_calls.map((tc) => ({
        id: tc.id || null,
        name: tc.function?.name || "tool",
        args: tc.function?.arguments || "",
        ident: !!(tc.id || tc.function?.name),
        index: Number.isInteger(tc.index) ? tc.index : null
      })),
      stopReason: "tool_use"
    });
  }
  if (finishReason) out.push({ kind: "finish", finishReason });
  return out;
}

// thinking 占位签名统一归 thinking.js（SYNTHETIC_THINKING_SIGNATURE）：
// 流式 signature_delta 与非流式 thinking 块须同值，否则同一思维链在两种出站形态下签名分叉。

// ---------------------------------------------------------------------------
// tool_call 分片 → 累积器（非流式落袋的唯一合并点，按 index 定址）
// ---------------------------------------------------------------------------

/**
 * 非流式落袋的 tool_call 分片合并（按 index 定址，缺 id 用占位槽位）。
 *
 * OpenAI 把一次工具调用拆成多个 chunk 增量下发：首个增量通常带 id/name，后续只带
 * arguments 片段。但**部分兼容上游的首片也不带 id**（reduceOpenAIChunkAll 已将
 * `id: tc.id || null` 显式建模），此时必须先建占位槽位，待 id 到达后把占位键迁移到真实 id ——
 * 否则同一次调用会占两个槽位，最终产出重复的 tool_use block。
 *
 * 定址必须用 `c.index`（上游原始序号），不能用 chunk 内序号 ci：稀疏分片下每 chunk
 * 只带一个 index（如 index:1 的续片位于 calls[0]），按 ci 查 order[0] 会污染首槽位。
 * 占位键按 `__idx_${index}` 确定性命名，使跨 chunk 的同 index 碎片总能直达同一槽位。
 *
 * 迁移的实现要点：占位态必须显式记录（`slot.ident === false`），不能靠键名推断 ——
 * 续片到达时 key 取 c.id，而占位槽位键是 `__idx_N`，两者不等，按 id 查必然落空。
 * 故此处先按 index 定位占位槽位再迁移，而非先按 id 查。
 *
 * @param {Map} frags - tool id（或占位键）-> { key, id, name, args, ident }
 * @param {Array} calls - 本 chunk 的 emission.calls（每项含 index）
 */
export function mergeSseToolFrags(frags, calls) {
  if (!Array.isArray(calls)) return frags;
  for (let ci = 0; ci < calls.length; ci++) {
    const c = calls[ci];
    if (!c) continue;
    const pos = Number.isInteger(c.index) ? c.index : ci;
    const placeholderKey = `__idx_${pos}`;
    // 无 index 的不规范上游按到达序回落：取实时插入序（非快照，避免同循环内污染）。
    // 有显式 index 时只认确定性占位键，不回落插入序（否则乱序到达会污染他槽）。
    const live = Number.isInteger(c.index) ? undefined : Array.from(frags.values());

    if (c.id) {
      // 有 id：优先按 id 命中；未命中时尝试接管同 index 的占位槽位（首片无 id 的场景）。
      let slot = frags.get(c.id);
      let fromKey = c.id;
      if (!slot) {
        const cand = frags.get(placeholderKey) ?? live?.[pos];
        if (cand && !cand.ident) {
          slot = cand;
          fromKey = cand.key;
        }
      }
      if (slot) {
        if (typeof c.args === "string") slot.args += c.args;
        if (c.name && c.name !== "tool") slot.name = c.name;
        if (!slot.ident) {
          // 占位槽位首次拿到真实 id：迁移键，使后续分片能按 id 直达。
          frags.delete(fromKey);
          slot.id = c.id;
          slot.ident = true;
          slot.key = c.id;
          frags.set(c.id, slot);
        }
      } else {
        frags.set(c.id, { key: c.id, id: c.id, name: c.name, args: typeof c.args === "string" ? c.args : "", ident: true });
      }
    } else {
      // 无 id 的分片：按 index 定址回填；无 index 的不规范续片按实时插入序回落到同位槽位。
      const cand = frags.get(placeholderKey) ?? live?.[pos];
      if (cand) {
        if (typeof c.args === "string") cand.args += c.args;
        if (c.name && c.name !== "tool") cand.name = c.name;
      } else {
        frags.set(placeholderKey, { key: placeholderKey, id: placeholderKey, name: c.name, args: typeof c.args === "string" ? c.args : "", ident: false });
      }
    }
  }
  return frags;
}

/**
 * 流式 content block 状态机 —— 封装 Anthropic「同一时刻至多一个开放 block」的约束。
 *
 * 抽出的理由：SSE 读循环内原本用 6 个散落的可变变量（blockIndex/blockType/toolId/toolName/
 * emittedChars/stopReason）维护状态，导致读循环圈复杂度达 64。把状态与其转移规则收进此处后，
 * 读循环只表达「解码 → 分派」，不再承担状态转移的分支判断。
 *
 * 所有 `*Frame()` 方法返回**待写出的 SSE 帧字符串数组**（可能为空），不发 IO ——
 * 调用方负责 `await writer.write()`，从而本类可脱离流做纯单测。
 */
export class StreamBlockState {
  /**
   * @param {string[]} [stopSequences] - 本次请求下发的停止序列。
   *   为空（绝大多数请求）时**完全不累积 textTail** —— 该功能未被请求，
   *   不应在每条正文增量上做字符串分配（这是 TTFT 关键路径）。
   */
  constructor(stopSequences = []) {
    this.blockIndex = -1;
    this.blockType = null;   // null | "thinking" | "text" | "tool_use"
    this.toolId = null;
    this.toolName = null;
    this.emittedChars = 0;
    this.stopReason = "end_turn";
    // 正文尾部窗口：仅保留「最长停止序列」长度的尾部，供终局判定 stop_sequence 命中。
    // 窗口必须 >= 最长序列，否则长序列永远匹配不到（曾写死 64，长度 >64 的序列恒失配）。
    // 无停止序列时为 0 长度，textDelta 走零开销分支。
    this.tailWindow = stopSequences.reduce(
      (m, s) => (typeof s === "string" && s.length > m ? s.length : m), 0
    );
    this.textTail = "";
  }

  #frame(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  #stopFrame() {
    if (this.blockType === null || this.blockIndex < 0) return [];
    const out = [];
    // thinking 块收尾前补 signature_delta：Anthropic 规定 thinking block 必须带
    // signature 才能被客户端回传，否则下一轮可能因 signature: Field required 报 400。
    // 上游为 OpenAI 协议，无 signature 概念，合成非空占位串满足协议形状即可；
    // 客户端回传的该块会在请求侧被丢弃（见 transform.js），不会打到上游。
    if (this.blockType === "thinking") {
      out.push(this.#frame("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "signature_delta", signature: SYNTHETIC_THINKING_SIGNATURE }
      }));
    }
    out.push(this.#frame("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
    this.blockType = null;
    return out;
  }

  /**
   * 打开指定类型的新 block（若已有开放 block 则先关闭）。
   * @returns {string[]} 关闭帧 + 开启帧
   */
  open(kind, { toolId = null, toolName = null } = {}) {
    const out = this.#stopFrame();
    this.blockIndex += 1;
    this.blockType = kind;
    if (kind === "tool_use") {
      this.toolId = toolId;
      this.toolName = toolName;
      out.push(this.#frame("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "tool_use", id: toolId, name: toolName, input: {} }
      }));
    } else {
      const contentBlock = kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
      out.push(this.#frame("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: contentBlock
      }));
    }
    return out;
  }

  /** thinking 增量帧；计入 emittedChars，与非流式 output_tokens 口径一致（含 thinking）。 */
  thinkingDelta(text) {
    if (this.blockType !== "thinking") return [];
    this.emittedChars += text.length;
    return [this.#frame("content_block_delta", {
      type: "content_block_delta", index: this.blockIndex,
      delta: { type: "thinking_delta", thinking: text }
    })];
  }

  /** 正文增量帧；自动累计 emittedChars（供字符数/4 回退估算）。 */
  textDelta(text) {
    if (this.blockType !== "text") return [];
    this.emittedChars += text.length;
    // 仅在本请求确实下发了停止序列时才维护尾部窗口 —— 否则热路径零额外开销。
    if (this.tailWindow > 0) {
      const joined = this.textTail + text;
      this.textTail = joined.length > this.tailWindow
        ? joined.slice(joined.length - this.tailWindow)
        : joined;
    }
    return [this.#frame("content_block_delta", {
      type: "content_block_delta", index: this.blockIndex,
      delta: { type: "text_delta", text }
    })];
  }

  /** 工具入参增量帧（partial_json）。 */
  inputJsonDelta(partialJson) {
    if (this.blockType !== "tool_use") return [];
    return [this.#frame("content_block_delta", {
      type: "content_block_delta", index: this.blockIndex,
      delta: { type: "input_json_delta", partial_json: partialJson }
    })];
  }

  /**
   * 把一个 emission（reduceOpenAIChunkAll 的产物）转为待写出的 SSE 帧。
   * 分派逻辑收在这里，使读循环只表达「解码 → 交给状态机 → 写出」，
   * 不再承担 if/else-if 长链（原本 5 个 kind 分支占读循环复杂度的大头）。
   *
   * @param {Object} emission - { kind, text?, calls?, finishReason? }
   * @returns {string[]} 待写帧
   */
  applyEmission(emission) {
    if (!emission) return [];
    switch (emission.kind) {
      case "thinking": {
        const out = this.blockType !== "thinking" ? this.open("thinking") : [];
        return [...out, ...this.thinkingDelta(emission.text)];
      }
      case "text": {
        const out = this.blockType !== "text" ? this.open("text") : [];
        return [...out, ...this.textDelta(emission.text)];
      }
      case "tool_use": {
        this.setStopReason("tool_use");
        const out = [];
        for (const tc of emission.calls || []) {
          const toolId = () => tc.id || ("call_" + Math.random().toString(36).substring(2, 9));
          if (tc.ident) out.push(...this.open("tool_use", { toolId: toolId(), toolName: tc.name }));
          if (tc.args) {
            // 纯 args 碎片先到且无活动 tool_use 块：先开匿名块，避免发出非法 index:-1。
            if (this.blockIndex < 0 || this.blockType !== "tool_use") {
              out.push(...this.open("tool_use", { toolId: toolId(), toolName: tc.name || "tool" }));
            }
            out.push(...this.inputJsonDelta(tc.args));
          }
        }
        return out;
      }
      case "finish":
        if (finishReasonToAnthropic(emission.finishReason) === "tool_use") this.setStopReason("tool_use");
        return [];
      default:
        return [];
    }
  }

  /** 关闭当前 block（无论类型）。 */
  close() {
    return this.#stopFrame();
  }

  /** 记录终局 stop_reason（仅当当前仍是默认 end_turn 时才覆盖，避免被中途 chunk 降级）。 */
  setStopReason(reason) {
    if (reason && this.stopReason === "end_turn") this.stopReason = reason;
  }
}

/**
 * 累积的 tool_call 列表 → Anthropic `tool_use` content blocks。
 * Anthropic 要求 input 是 object，而 OpenAI 的 arguments 是 JSON 字符串，需解析；
 * 解析失败保留原文（`_raw`）而非丢弃 —— 客户端可归因，比静默丢调用好。
 * 缺 id 时补 `call_` 随机 id（与 SSE 落袋口径一致），绝不产出 `id:null` 非法块。
 *
 * @param {Array} acc - 累积出的列表 [{ id, name, args }]
 * @returns {Array} Anthropic tool_use blocks（空输入返回空数组）
 */
export function toolCallsToAnthropicBlocks(acc) {
  if (!Array.isArray(acc) || acc.length === 0) return [];
  const blocks = [];
  for (const tc of acc) {
    let toolInput = {};
    const rawArgs = tc.args;
    if (rawArgs && typeof rawArgs === "object") {
      toolInput = rawArgs;
    } else if (typeof rawArgs === "string" && rawArgs.trim()) {
      try {
        toolInput = JSON.parse(rawArgs);
      } catch {
        toolInput = { _raw: rawArgs };
      }
    }
    blocks.push({
      type: "tool_use",
      id: tc.id || ("call_" + Math.random().toString(36).substring(2, 10)),
      name: tc.name || "tool",
      input: toolInput
    });
  }
  return blocks;
}

/**
 * 上游 SSE 行源 —— 两条消费路径（流式 / 非流式）共享的 parsed-chunk 接缝。
 *
 * 收敛前两处各写一遍读循环（buffer → 按行切分 → data: 过滤 → [DONE] 跳过 →
 * JSON.parse → 坏行限流告警）：删掉本模块只会把循环搬回两处，故它通过
 * deletion test，自立为 seam。
 *
 * 本模块只拥有「行缓冲解析」：usage / cache 提取与发射归约仍归消费方
 *（两处 token 记账变量名与落袋语义不同，不宜上收）。
 *
 * @param {ReadableStreamDefaultReader} reader - 上游 body 的 reader（abort / stall 接线仍归调用方）
 * @param {Object} [options]
 * @param {TextDecoder} [options.decoder] - 复用调用方 decoder，不传则自建
 * @param {string} [options.warnMessage] - 坏行告警文案（流式 / 非流式各保留原措辞）
 * @param {(value: Uint8Array) => void} [options.onBytes] - 每批字节到达钩子（流式停滞熔断计时用）
 * @param {{ text: string }} [options.tail] - 出口：流结束时未成行的剩余缓冲（单 JSON 回退用）
 * @yields {{ parsed: any, rawLine: string }} 成功解析的 chunk 与其原始 JSON 行
 */
export async function* iterSseParsedChunks(reader, options = {}) {
  const decoder = options.decoder ?? new TextDecoder();
  const warnMessage = options.warnMessage ?? "Skipping malformed SSE line";
  const onBytes = typeof options.onBytes === "function" ? options.onBytes : null;
  const tail = options.tail ?? null;

  let badLineWarns = 0;
  const queue = [];
  let rawBuffer = "";
  let dispatchedCount = 0;

  const parser = createParser({
    onEvent(event) {
      const trimmed = event.data?.trim();
      if (!trimmed) return;
      dispatchedCount++;
      if (trimmed === "[DONE]") return;

      try {
        queue.push({ parsed: JSON.parse(trimmed), rawLine: trimmed });
      } catch {
        if (trimmed.includes("\n")) {
          for (const rawLine of trimmed.split("\n")) {
            const lineTrimmed = rawLine.trim();
            if (!lineTrimmed || lineTrimmed === "[DONE]") continue;
            try {
              queue.push({ parsed: JSON.parse(lineTrimmed), rawLine: lineTrimmed });
            } catch {
              if (badLineWarns++ < 3) log.warn(warnMessage, { line: String(lineTrimmed).slice(0, 120) });
            }
          }
          return;
        }
        if (badLineWarns++ < 3) log.warn(warnMessage, { line: String(trimmed).slice(0, 120) });
      }
    }
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onBytes) onBytes(value);
    const text = decoder.decode(value, { stream: true });
    rawBuffer += text;
    if (dispatchedCount > 0 && rawBuffer.length > 4096) {
      rawBuffer = rawBuffer.slice(rawBuffer.length - 4096);
    }
    parser.feed(text);
    while (queue.length > 0) {
      yield queue.shift();
    }
  }

  parser.feed("\n\n");
  parser.reset({ consume: true });
  while (queue.length > 0) {
    yield queue.shift();
  }

  if (tail && typeof tail === "object") {
    if (dispatchedCount === 0) {
      tail.text = rawBuffer;
    } else {
      const lastDataIdx = Math.max(rawBuffer.lastIndexOf("\ndata:"), rawBuffer.startsWith("data:") ? 0 : -1);
      if (lastDataIdx !== -1) {
        const afterLastData = rawBuffer.slice(lastDataIdx);
        const nextNl = afterLastData.indexOf("\n");
        tail.text = nextNl !== -1 ? afterLastData.slice(nextNl + 1).replace(/^[\r\n]+/, "") : "";
      } else {
        tail.text = "";
      }
    }
  }
}
