// 响应侧转译 —— OpenAI SSE/JSON → Anthropic SSE/JSON（reduce / extractors / stream）。
// 流式与非流式共享 extractors，两处不再各自拼装；路由见 ./dispatch.js。
import { corsHeaders } from "../http/headers.js";
import { recordUpstreamCache } from "../core/cacheStats.js";
import { log } from "../logging/logger.js";

// 模块级单例 Encoder / Decoder 与预编码静态 Buffer（零 GC 内存分配）
const textEncoder = new TextEncoder();
const KEEP_ALIVE_BYTES = textEncoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n");
const EVENT_MSG_STOP_BYTES = textEncoder.encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");

// 内部流式转译：OpenAI SSE -> Anthropic SSE（优化：零内存拷贝保活与事件复用）

// 纯函数：把单个已解析的 OpenAI SSE chunk 归约为一条「发射指令」。
// 不做任何 I/O，只做分类与字段提取 —— 这是流式转译里最易回归、也最该被测试的部分。
// 返回 null 表示该 chunk 无需发射任何事件（如空 delta、[DONE] 已在外层过滤）。
// 可能的 kind:
//   "error"    —— 上游业务错误/非零 code，应降级为 notice 文本
//   "thinking" —— DeepSeek reasoning_content 思维链增量
//   "text"     —— 正文文本增量
//   "tool_use" —— 工具调用块（可能伴随 id/name/arguments）
// 纯函数：从已解析的上游 JSON 中提取错误消息（error 字段 / msg / message / 非零 code）。
// reduceOpenAIChunkAll 与 formatOpenAIToAnthropicJson 共享，避免两处各自拼装。
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
 * @param {boolean} [options.hasStopSequences=false]
 * @param {string} [options.text=""]
 * @param {string[]} [options.stopSequences=[]]
 * @returns {{stopReason: string, stopSequence: string|null}}
 */
export function resolveStopDetails(finishReason, { hasStopSequences = false, text = "", stopSequences = [] } = {}) {
  switch (finishReason) {
    case "length":
      return { stopReason: "max_tokens", stopSequence: null };
    case "tool_calls":
    case "function_call":
    case "tool_use":
      return { stopReason: "tool_use", stopSequence: null };
    case "stop_sequence": {
      const hit = Array.isArray(stopSequences)
        ? stopSequences.find(s => typeof s === "string" && s.length > 0 && text.includes(s))
        : null;
      return {
        stopReason: "stop_sequence",
        stopSequence: hit || (Array.isArray(stopSequences) && stopSequences.length > 0 ? stopSequences[0] : null)
      };
    }
    case "stop": {
      const stopsActive = hasStopSequences !== undefined ? hasStopSequences : (Array.isArray(stopSequences) && stopSequences.length > 0);
      if (stopsActive && Array.isArray(stopSequences) && stopSequences.length > 0) {
        const hit = stopSequences.find(s => typeof s === "string" && s.length > 0 && text.includes(s));
        if (hit) {
          return { stopReason: "stop_sequence", stopSequence: hit };
        }
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

// 上游流停滞熔断：连续该时长收不到上游任何字节即判定上游卡死（如某些模型只回 200 头然后静默），
// 主动收尾而不是让客户端挂到平台超时。只看“无字节”时长，持续吐 token 的慢模型不受影响。
// options.stallMs 供测试注入小值；生产默认 180s（< Vercel 300s 上限，远大于实测最慢模型的 118s）。
const UPSTREAM_STALL_MS = 180 * 1000;

// thinking block 回传所需的占位 signature（Anthropic 只要求 non-empty string）。
// 上游 OpenAI 协议不产生真实 signature，此处合成仅为满足协议形状。
const SYNTHETIC_THINKING_SIGNATURE = "gateway-synthetic-thinking-signature";

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
  // 必须初始化为空串：下方是 `buffer += decoder.decode(...)`，无初值会拼出 "undefined..."。
  let buffer = "";
  let badLineWarns = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onBytes) onBytes(value);
    buffer += decoder.decode(value, { stream: true });
    let pos = 0;
    let lineEnd;
    while ((lineEnd = buffer.indexOf("\n", pos)) !== -1) {
      const line = buffer.slice(pos, lineEnd).trim();
      pos = lineEnd + 1;
      if (!line || !line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (jsonStr === "[DONE]") continue;
      try {
        yield { parsed: JSON.parse(jsonStr), rawLine: jsonStr };
      } catch {
        if (badLineWarns++ < 3) log.warn(warnMessage, { line: String(jsonStr).slice(0, 120) });
      }
    }
    buffer = pos > 0 ? buffer.slice(pos) : buffer;
  }
  if (tail && typeof tail === "object") tail.text = buffer;
}

export function streamOpenAIToAnthropic(upstreamResponse, requestedModel, clientSignal = null, extraHeaders = {}, options = {}) {
  const stallMs = Number.isFinite(options?.stallMs) && options.stallMs > 0 ? options.stallMs : UPSTREAM_STALL_MS;
  // 本次请求下发的停止序列：用于流式终局判定 stop_reason 是 stop_sequence 还是 end_turn。
  const stopSequences = Array.isArray(options?.stopSequences) ? options.stopSequences : [];
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const sseHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...corsHeaders,
    ...extraHeaders
  };

  (async () => {
    let lastUpstreamByteAt = Date.now();
    let stalled = false;
    // 保活/熔断轮询间隔：跟随 stallMs 而非写死 4s。
    // 写死会让注入小 stallMs 的测试白等一个整拍（stallMs:50 也要等 4s），
    // 生产上则让检测时刻落在 4s 网格上 —— stallMs=180s 最坏要 184s 才熔断。
    // 下限 10ms 防误传 0 造成忙轮询；上限 4s 保持原有保活节奏不变。
    const pingIntervalMs = Math.min(4000, Math.max(10, Math.floor(stallMs / 4)));
    let pingInterval = setInterval(async () => {
      // 停滞熔断：上游长时间零字节 → 取消上游读取，读循环以 done 收尾走正常闭环
      //（不 abort writer，否则下游收不到 message_stop）。客户端看到空内容而非无限挂起。
      if (!stalled && Date.now() - lastUpstreamByteAt > stallMs) {
        stalled = true;
        log.warn("Upstream stalled, closing stream", { stall_ms: stallMs, model: requestedModel });
        clearInterval(pingInterval);
        try { upstreamReader?.cancel(new Error("Upstream stalled")); } catch {}
        return;
      }
      try {
        await writer.write(KEEP_ALIVE_BYTES);
      } catch {}
    }, pingIntervalMs);

    // 监听客户端主动中断取消（Ctrl+C / 停止生成），级联终止上游读取与保活定时器。
    // 上游 reader 必须同步 cancel：否则协程卡在 reader.read()（上游停顿）或 writer.write()
    //（下游已断、背压永不释放），定时器与 IIFE 泄漏到进程结束。Vercel Node 入口若不断开
    // 传播 signal，这里就是每次“停止生成”都漏一个定时器的地方。
    let upstreamReader = null;
    const abortUpstream = (reason) => {
      clearInterval(pingInterval);
      try { upstreamReader?.cancel(reason); } catch {}
      try { writer.abort(reason instanceof Error ? reason : new Error("Client aborted")); } catch {}
    };
    if (clientSignal) {
      if (clientSignal.aborted) {
        abortUpstream(clientSignal.reason);
        return new Response(readable, { status: 200, headers: sseHeaders });
      }
      clientSignal.addEventListener("abort", () => abortUpstream(clientSignal.reason), { once: true });
    }

    // reader 必须在首次 await 之前创建并挂到 upstreamReader：
    // abort 事件只能交错在 await 处，若赋值在 message_start 写之后，abort 恰落进来就 cancel 不到。
    const reader = upstreamResponse.body.getReader();
    upstreamReader = reader;

    // message_start 在 try 之外：若下游恰在此刻断开，write 直接抛错，
    // 必须就地清理后返回，否则跳过下面的 try/finally 泄漏定时器。
    try {
      await writer.write(textEncoder.encode(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: requestedModel || "claude-3-5-sonnet-20241022",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })}\n\n`));
    } catch {
      clearInterval(pingInterval);
      return;
    }

    const streamDecoder = new TextDecoder();
    let buffer;

    // block 状态机：取代此前散落的 currentBlockIndex/Type/ToolId/ToolName 四个可变变量。
    const blockState = new StreamBlockState(stopSequences);
    // 批量写出状态机产出的 SSE 帧（状态机本身不发 IO，便于纯单测）。
    const writeAll = async (frames) => {
      for (const f of frames) await writer.write(textEncoder.encode(f));
    };
    // 本次响应见到的最大缓存命中 token 数（上游 usage 逐 chunk 到达，取最大记一次）
    let maxCachedTokens = 0;
    // 真实输出 token 数：优先采信上游 usage.completion_tokens（终局 chunk 常带），
    // 上游从不报 usage 时回退字符数/4 估算，取代此前的硬编码 60。
    let reportedOutputTokens = 0;
    // 真实输入 token 数：优先采信上游 usage.prompt_tokens（透传/翻译路径均可能携带），
    // 上游从不报 usage 时保持 0 —— Anthropic 线协议不允许凭空估算输入长度。
    let reportedInputTokens = 0;

    try {
      const tail = { text: "" };
      for await (const { parsed } of iterSseParsedChunks(reader, {
        decoder: streamDecoder,
        onBytes: (value) => { if (value?.byteLength) lastUpstreamByteAt = Date.now(); },
        tail,
      })) {
        const cached = extractCachedTokens(parsed);
        if (cached > maxCachedTokens) maxCachedTokens = cached;

        // 与非流式路径同源采信上游 usage（逐 chunk 覆盖，终局值胜出）；
        // 缺失 usage 的 chunk 保留原值，最终由字符数估算兜底。
        const chunkUsage = extractUsage(parsed, { input: reportedInputTokens, output: reportedOutputTokens });
        reportedOutputTokens = chunkUsage.output;
        reportedInputTokens = chunkUsage.input;

        // 全部分类走 reducer seam：同一 chunk 的 thinking/text/tool/finish 按序发射，
        // 不再各写一遍字段读取（error 独占，与旧语义一致）。
        const emissions = reduceOpenAIChunkAll(parsed);
        const errorEmission = emissions.find(e => e.kind === "error");
        if (errorEmission) {
          const errMsg = errorEmission.message;
          log.warn("Upstream stream error", { error: errMsg });
          if (blockState.blockType !== "text") await writeAll(blockState.open("text"));
          // notice 文本同样计入 emittedChars（textDelta 内部累计），与正文同口径，避免 output_tokens 偏小
          await writeAll(blockState.textDelta(`\n[Upstream Notice: ${errMsg}]\n`));
          continue;
        }

        for (const emission of emissions) {
        // 分派收进状态机：读循环只表达「解码 → 分派 → 写出」，不再承载 kind 长链。
        // 无 delta 的纯 finish 终局块同样经此处设置 stop_reason，不得用 delta 守卫跳过。
        await writeAll(blockState.applyEmission(emission));
        }
      }
      buffer = tail.text;

      // 若流结束时 buffer 尚存非 SSE 格式内容（如上游返回单一 JSON）
      if (blockState.blockIndex === -1 && buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          const text = parsed.choices?.[0]?.message?.content ||
                       parsed.choices?.[0]?.delta?.content ||
                       parsed.error?.message ||
                       parsed.msg ||
                       (parsed.code ? `Upstream error ${parsed.code}` : buffer.trim());
          if (text) {
            await writeAll(blockState.open("text"));
            await writeAll(blockState.textDelta(text));
          }
        } catch {}
      }

      // 核心协议保障：若整个流未产生任何 content_block，强制合成 1 个空 text 块闭环，绝不让 Claude Code 触发 ph.length === 0 的流式回退报警
      // 停滞熔断触发时带一句明示，避免客户端把“上游卡死”误读成“模型回了空答案”。
      if (blockState.blockIndex === -1) {
        await writeAll(blockState.open("text"));
        if (stalled) {
          await writeAll(blockState.textDelta(`\n[Gateway Warning: Upstream stalled, no data for ${Math.round(stallMs / 1000)}s]\n`));
        }
        await writeAll(blockState.close());
      } else {
        await writeAll(blockState.close());
      }

      // message_delta.usage.output_tokens 是 Anthropic 线协议字段，客户端会读；
      // 取上游 usage 与字符估算的较大值（与非流式 formatOpenAIToAnthropicJson 口径一致）。
      // input_tokens 采信上游 usage.prompt_tokens：缺失时为 0（不估算输入长度）。
      const finalOutputTokens = Math.max(reportedOutputTokens, Math.ceil(blockState.emittedChars / 4));
      // 终局 stop_reason 与 stop_sequence：统一委托 resolveStopDetails 判定
      const stopDetails = resolveStopDetails(blockState.stopReason, {
        text: blockState.textTail,
        stopSequences
      });
      await writer.write(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopDetails.stopReason, stop_sequence: stopDetails.stopSequence },
        usage: { input_tokens: reportedInputTokens, output_tokens: finalOutputTokens }
      })}\n\n`));

      await writer.write(EVENT_MSG_STOP_BYTES);
    } catch (err) {
      log.error("Stream error", { error: err?.message || String(err) });
      // 容灾输出：即使网络或上游异常断流，也输出结构化友好提示并优雅闭环，不直接 crash 客户端
      try {
        if (blockState.blockType !== "text") {
          await writeAll(blockState.open("text"));
        }
        const interruptText = `\n[Gateway Warning: Upstream stream interrupted (${err.message || "EOF"})]\n`;
        await writeAll(blockState.textDelta(interruptText));
        await writeAll(blockState.close());
        // 错误路径同样发射真实计数（含警告文本），与正常闭环保持一致，避免硬编码漂移。
        const errOutputTokens = Math.max(reportedOutputTokens, Math.ceil(blockState.emittedChars / 4));
        await writer.write(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { input_tokens: reportedInputTokens, output_tokens: errOutputTokens }
        })}\n\n`));
        await writer.write(EVENT_MSG_STOP_BYTES);
      } catch {}
    } finally {
      clearInterval(pingInterval);
      // 无论正常收尾还是异常断流都记一次：命中率 = cachedResponses / responses
      try { recordUpstreamCache(maxCachedTokens); } catch {}
      try { await writer.close(); } catch {}
    }
  })().catch(err => {
    try { writer.abort(err); } catch {}
  });

  return new Response(readable, {
    status: 200,
    headers: sseHeaders
  });
}

// 内部非流式转译：OpenAI -> Anthropic JSON (优化：增量流式读取，零全量内存拷贝)
// 导出给 ./dispatch.js 的非流式路径使用（对外仍经 exchange.js 门面）。
export async function formatOpenAIToAnthropicJson(upstreamResponse, requestedModel, extraHeaders = {}, options = {}) {
  const stopSequences = Array.isArray(options?.stopSequences) ? options.stopSequences : [];
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let accumulatedThinking = "";
  let accumulatedToolCalls = [];
  const sseToolFrags = new Map(); // tool id -> { id, name, args }，SSE 分片在此按 id 拼接
  let buffer;
  let inputTokens = 0;
  let outputTokens = 0;
  let accumulatedFinishReason = null;
  let maxCachedTokens = 0;

  try {
    const tail = { text: "" };
    for await (const { parsed } of iterSseParsedChunks(reader, {
      decoder,
      warnMessage: "Skipping malformed SSE line (non-streaming)",
      tail,
    })) {
      // 同流式路径：全部分类走 reducer seam。SSE 形态的 tool_calls arguments 是分片到达，
      // 按 id 拼接到一次后再整体解析（与流式 input_json_delta 语义对齐）；无 id 碎片无法
      // 定址成块，直接丢弃（此前整段 tool_calls 被静默丢弃，stop_reason 恒为 end_turn）。
      for (const emission of reduceOpenAIChunkAll(parsed)) {
        if (emission.kind === "error") {
          accumulated += `\n[Upstream Notice: ${emission.message}]\n`;
        } else if (emission.kind === "thinking") {
          accumulatedThinking += emission.text;
        } else if (emission.kind === "text") {
          accumulated += emission.text;
        } else if (emission.kind === "tool_use") {
          // 按 index 定址合并：续片通常只带 index+arguments、无 id。
          // emission.calls 与 delta.tool_calls 同序，chunk 内序号即 index。
          mergeSseToolFrags(sseToolFrags, emission.calls);
        } else if (emission.kind === "finish") {
          accumulatedFinishReason = emission.finishReason;
        }
      }
      const usage = extractUsage(parsed, { input: inputTokens, output: outputTokens });
      inputTokens = usage.input;
      outputTokens = usage.output;
      const cached = extractCachedTokens(parsed);
      if (cached > maxCachedTokens) maxCachedTokens = cached;
    }
    buffer = tail.text;

    if (!accumulated && buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        const message = parsed.choices?.[0]?.message;
        const reasoning = message?.reasoning_content || message?.reasoning ||
                          parsed.choices?.[0]?.delta?.reasoning_content || parsed.choices?.[0]?.delta?.reasoning;
        if (reasoning) accumulatedThinking = reasoning;
        if (message && message.content !== undefined && message.content !== null) {
          accumulated = message.content;
        } else if (parsed.choices?.[0]?.delta?.content) {
          accumulated = parsed.choices[0].delta.content;
        } else {
          accumulated = extractErrorMessage(parsed) || (accumulatedThinking ? "" : buffer.trim());
        }
        // 提取非流式响应中的工具调用（直接存归一化形态，避免二次嵌套 OpenAI 包裹层）
        if (Array.isArray(message?.tool_calls)) {
          for (const tc of message.tool_calls) {
            accumulatedToolCalls.push({
              id: tc.id || null,
              name: tc.function?.name || "tool",
              args: tc.function?.arguments ?? "{}"
            });
          }
        }
        const usage = extractUsage(parsed, { input: inputTokens, output: outputTokens });
        inputTokens = usage.input;
        outputTokens = usage.output;
        const cachedTail = extractCachedTokens(parsed);
        if (cachedTail > maxCachedTokens) maxCachedTokens = cachedTail;
        // 保存 finish_reason 用于正确映射 Anthropic stop_reason
        if (parsed.choices?.[0]) {
          accumulatedFinishReason = parsed.choices[0].finish_reason;
        }
      } catch {
        accumulated = buffer.trim();
      }
    }
  } finally {
    reader.releaseLock();
  }

  // SSE 分片 tools 落袋：拼接后的 args 与单包形态走同一解析路径
  // 占位态（ident=false，上游始终没给 id）才需要补生成 id；已迁移到真实 id 的直接用。
  for (const t of sseToolFrags.values()) {
    const id = t.ident && t.id ? t.id : ("call_" + Math.random().toString(36).substring(2, 10));
    accumulatedToolCalls.push({ id, name: t.name, args: t.args });
  }

  accumulated = accumulated || " ";
  outputTokens = Math.max(outputTokens, Math.ceil((accumulated.length + accumulatedThinking.length) / 4));

  const content = [];
  if (accumulatedThinking) {
    content.push({
      type: "thinking",
      thinking: accumulatedThinking,
      signature: "sig_synthetic_done"
    });
  }

  // 工具调用：映射 OpenAI tool_calls 到 Anthropic tool_use content blocks
  // Anthropic tool_use.input 必须是 object；OpenAI arguments 是 JSON 字符串，需解析
  // accumulatedToolCalls 到 Anthropic tool_use content blocks
  if (Array.isArray(accumulatedToolCalls) && accumulatedToolCalls.length > 0) {
    content.push(...toolCallsToAnthropicBlocks(accumulatedToolCalls));
  }

  content.push({ type: "text", text: accumulated });

  try { recordUpstreamCache(maxCachedTokens); } catch {}

  // 停序列命中判定：统一委托 resolveStopDetails 判定
  const stopDetails = resolveStopDetails(accumulatedFinishReason, {
    text: accumulated,
    stopSequences
  });

  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    content: content,
    model: requestedModel || "claude-3-5-haiku-20241022",
    stop_reason: stopDetails.stopReason,
    stop_sequence: stopDetails.stopSequence,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extraHeaders }
  });
}
