// 响应侧转译 —— OpenAI SSE/JSON → Anthropic SSE/JSON（reduce / extractors / stream）。
// 流式与非流式共享 extractors，两处不再各自拼装；路由见 ./dispatch.js。
import { corsHeaders } from "../http/headers.js";
import { recordUpstreamCache } from "../core/cacheStats.js";

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
// reduceOpenAIChunk 与 formatOpenAIToAnthropicJson 共享，避免两处各自拼装。
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
export function extractUsage(parsed, current = { input: 20, output: 1 }) {
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

// OpenAI finish_reason -> Anthropic stop_reason 映射
// Anthropic 只有 end_turn / max_tokens / stop_sequence / tool_use 四种；
// content_filter（安全过滤截断）没有对应项，归为 end_turn（自然停止），
// 不能用 stop_sequence（那表示命中用户自定义停止序列，语义错误）。
export function finishReasonToAnthropic(finishReason) {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
    default:
      return "end_turn";
  }
}

export function reduceOpenAIChunk(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // 上游业务错误（Tencent code !== 0 或显式 error 字段）
  if (isUpstreamError(parsed)) {
    const msg = extractErrorMessage(parsed) || "Unknown error";
    return { kind: "error", message: msg };
  }

  const delta = parsed.choices?.[0]?.delta;
  const finishReason = parsed.choices?.[0]?.finish_reason;

  // 工具调用：可能在同一 chunk 内携带多个 tool_call
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
    const calls = delta.tool_calls.map(tc => ({
      id: tc.id || null,
      name: tc.function?.name || "tool",
      arguments: tc.function?.arguments || ""
    }));
    return { kind: "tool_use", calls, stopReason: "tool_use" };
  }

  // 思维链增量（兼容 DeepSeek reasoning_content 与 OpenCode / MiMo reasoning）
  const reasoningDelta = delta?.reasoning_content || delta?.reasoning;
  if (reasoningDelta) {
    return { kind: "thinking", text: reasoningDelta };
  }

  // 正文增量
  if (delta?.content) {
    return { kind: "text", text: delta.content };
  }

  // finish_reason 标记（无内容，但影响最终 stop_reason）
  if (finishReason === "tool_calls") {
    return { kind: "tool_use", calls: [], stopReason: "tool_use" };
  }

  return null;
}

// 上游流停滞熔断：连续该时长收不到上游任何字节即判定上游卡死（如某些模型只回 200 头然后静默），
// 主动收尾而不是让客户端挂到平台超时。只看“无字节”时长，持续吐 token 的慢模型不受影响。
// options.stallMs 供测试注入小值；生产默认 180s（< Vercel 300s 上限，远大于实测最慢模型的 118s）。
export const UPSTREAM_STALL_MS = 180 * 1000;

export function streamOpenAIToAnthropic(upstreamResponse, requestedModel, clientSignal = null, extraHeaders = {}, options = {}) {
  const stallMs = Number.isFinite(options?.stallMs) && options.stallMs > 0 ? options.stallMs : UPSTREAM_STALL_MS;
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
    let pingInterval = setInterval(async () => {
      // 停滞熔断：上游长时间零字节 → 取消上游读取，读循环以 done 收尾走正常闭环
      //（不 abort writer，否则下游收不到 message_stop）。客户端看到空内容而非无限挂起。
      if (!stalled && Date.now() - lastUpstreamByteAt > stallMs) {
        stalled = true;
        console.warn(`[Stream Stall] No upstream bytes for ${stallMs}ms, closing stream for model "${requestedModel}"`);
        clearInterval(pingInterval);
        try { upstreamReader?.cancel(new Error("Upstream stalled")); } catch (e) {}
        return;
      }
      try {
        await writer.write(KEEP_ALIVE_BYTES);
      } catch (e) {}
    }, 4000);

    // 监听客户端主动中断取消（Ctrl+C / 停止生成），级联终止上游读取与保活定时器。
    // 上游 reader 必须同步 cancel：否则协程卡在 reader.read()（上游停顿）或 writer.write()
    //（下游已断、背压永不释放），定时器与 IIFE 泄漏到进程结束。Vercel Node 入口若不断开
    // 传播 signal，这里就是每次“停止生成”都漏一个定时器的地方。
    let upstreamReader = null;
    const abortUpstream = (reason) => {
      clearInterval(pingInterval);
      try { upstreamReader?.cancel(reason); } catch (e) {}
      try { writer.abort(reason instanceof Error ? reason : new Error("Client aborted")); } catch (e) {}
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
        usage: { input_tokens: 15, output_tokens: 1 }
      }
    })}\n\n`));
    } catch (e) {
      clearInterval(pingInterval);
      return;
    }

    const streamDecoder = new TextDecoder();
    let buffer = "";

    let currentBlockIndex = -1;
    let currentBlockType = null;
    let currentToolId = null;
    let currentToolName = null;
    let finalStopReason = "end_turn";
    // 本次响应见到的最大缓存命中 token 数（上游 usage 逐 chunk 到达，取最大记一次）
    let maxCachedTokens = 0;

    const closeCurrentBlock = async () => {
      if (currentBlockType !== null && currentBlockIndex >= 0) {
        await writer.write(textEncoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: currentBlockIndex
        })}\n\n`));
        currentBlockType = null;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) lastUpstreamByteAt = Date.now();

        buffer += streamDecoder.decode(value, { stream: true });
        let pos = 0;
        let lineEnd;
        while ((lineEnd = buffer.indexOf("\n", pos)) !== -1) {
          const line = buffer.slice(pos, lineEnd).trim();
          pos = lineEnd + 1;
          if (!line || !line.startsWith("data:")) continue;
          const jsonStr = line.slice(5).trim();
          if (jsonStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(jsonStr);
            const cached = extractCachedTokens(parsed);
            if (cached > maxCachedTokens) maxCachedTokens = cached;

            // 检查上游是否嵌入了业务错误（如 Tencent code !== 0 或 error 字段）
            // 委托纯函数 reducer 判定与提取错误消息，避免此分支逻辑与 reducer 分叉
            const errorEmission = reduceOpenAIChunk(parsed);
            if (errorEmission?.kind === "error") {
              const errMsg = errorEmission.message;
              console.warn(`[Stream Upstream Error] ${errMsg}`);
              if (currentBlockType !== "text") {
                await closeCurrentBlock();
                currentBlockIndex = Math.max(0, currentBlockIndex + 1);
                currentBlockType = "text";
                await writer.write(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: { type: "text", text: "" }
                })}\n\n`));
              }
              await writer.write(textEncoder.encode(
                `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"text_delta","text":${JSON.stringify(`\n[Upstream Notice: ${errMsg}]\n`)}}}\n\n`
              ));
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            // 思维链 (DeepSeek reasoning_content / OpenCode reasoning)
            const reasoningChunk = delta.reasoning_content || delta.reasoning || "";
            if (reasoningChunk) {
              if (currentBlockType !== "thinking") {
                await closeCurrentBlock();
                currentBlockIndex++;
                currentBlockType = "thinking";
                await writer.write(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: { type: "thinking", thinking: "" }
                })}\n\n`));
              }
              await writer.write(textEncoder.encode(
                `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"thinking_delta","thinking":${JSON.stringify(reasoningChunk)}}}\n\n`
              ));
            }

            // 正文内容
            const textChunk = delta.content || "";
            if (textChunk) {
              if (currentBlockType !== "text") {
                await closeCurrentBlock();
                currentBlockIndex++;
                currentBlockType = "text";
                await writer.write(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: currentBlockIndex,
                  content_block: { type: "text", text: "" }
                })}\n\n`));
              }
              await writer.write(textEncoder.encode(
                `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"text_delta","text":${JSON.stringify(textChunk)}}}\n\n`
              ));
            }

            // 工具调用
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              finalStopReason = "tool_use";
              for (const tc of delta.tool_calls) {
                if (tc.id || tc.function?.name) {
                  await closeCurrentBlock();
                  currentBlockIndex++;
                  currentBlockType = "tool_use";
                  currentToolId = tc.id || ("call_" + Math.random().toString(36).substring(2, 9));
                  currentToolName = tc.function?.name || "tool";
                  await writer.write(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: currentBlockIndex,
                    content_block: {
                      type: "tool_use",
                      id: currentToolId,
                      name: currentToolName,
                      input: {}
                    }
                  })}\n\n`));
                }
                if (tc.function?.arguments) {
                  await writer.write(textEncoder.encode(
                    `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(tc.function.arguments)}}}\n\n`
                  ));
                }
              }
            }

            if (parsed.choices?.[0]?.finish_reason === "tool_calls") {
              finalStopReason = "tool_use";
            }
          } catch (e) {}
        }
        buffer = pos > 0 ? buffer.slice(pos) : buffer;
      }

      // 若流结束时 buffer 尚存非 SSE 格式内容（如上游返回单一 JSON）
      if (currentBlockIndex === -1 && buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          const text = parsed.choices?.[0]?.message?.content ||
                       parsed.choices?.[0]?.delta?.content ||
                       parsed.error?.message ||
                       parsed.msg ||
                       (parsed.code ? `Upstream error ${parsed.code}` : buffer.trim());
          if (text) {
            currentBlockIndex = 0;
            currentBlockType = "text";
            await writer.write(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" }
            })}\n\n`));
            await writer.write(textEncoder.encode(
              `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`
            ));
          }
        } catch (e) {}
      }

      // 核心协议保障：若整个流未产生任何 content_block，强制合成 1 个空 text 块闭环，绝不让 Claude Code 触发 ph.length === 0 的流式回退报警
      // 停滞熔断触发时带一句明示，避免客户端把“上游卡死”误读成“模型回了空答案”。
      if (currentBlockIndex === -1) {
        currentBlockIndex = 0;
        await writer.write(textEncoder.encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`));
        if (stalled) {
          await writer.write(textEncoder.encode(
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(`\n[Gateway Warning: Upstream stalled, no data for ${Math.round(stallMs / 1000)}s]\n`)}}}\n\n`
          ));
        }
        await writer.write(textEncoder.encode(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`));
      } else {
        await closeCurrentBlock();
      }

      await writer.write(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: finalStopReason, stop_sequence: null },
        usage: { output_tokens: 60 }
      })}\n\n`));

      await writer.write(EVENT_MSG_STOP_BYTES);
    } catch (err) {
      console.error("[Stream Error]", err);
      // 容灾输出：即使网络或上游异常断流，也输出结构化友好提示并优雅闭环，不直接 crash 客户端
      try {
        if (currentBlockType !== "text") {
          await closeCurrentBlock();
          currentBlockIndex = Math.max(0, currentBlockIndex + 1);
          currentBlockType = "text";
          await writer.write(textEncoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: currentBlockIndex,
            content_block: { type: "text", text: "" }
          })}\n\n`));
        }
        await writer.write(textEncoder.encode(
          `event: content_block_delta\ndata: {"type":"content_block_delta","index":${currentBlockIndex},"delta":{"type":"text_delta","text":${JSON.stringify(`\n[Gateway Warning: Upstream stream interrupted (${err.message || "EOF"})]\n`)}}}\n\n`
        ));
        await closeCurrentBlock();
        await writer.write(textEncoder.encode(`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n`));
        await writer.write(EVENT_MSG_STOP_BYTES);
      } catch (e) {}
    } finally {
      clearInterval(pingInterval);
      // 无论正常收尾还是异常断流都记一次：命中率 = cachedResponses / responses
      try { recordUpstreamCache(maxCachedTokens); } catch (e) {}
      try { await writer.close(); } catch (e) {}
    }
  })().catch(err => {
    try { writer.abort(err); } catch (e) {}
  });

  return new Response(readable, {
    status: 200,
    headers: sseHeaders
  });
}

// 内部非流式转译：OpenAI -> Anthropic JSON (优化：增量流式读取，零全量内存拷贝)
// 导出给 ./dispatch.js 的非流式路径使用（对外仍经 exchange.js 门面）。
export async function formatOpenAIToAnthropicJson(upstreamResponse, requestedModel, extraHeaders = {}) {
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let accumulatedThinking = "";
  let accumulatedToolCalls = [];
  let buffer = "";
  let inputTokens = 20;
  let outputTokens = 1;
  let accumulatedFinishReason = null;
  let maxCachedTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          const parsed = JSON.parse(jsonStr);
          if (isUpstreamError(parsed)) {
            const errMsg = extractErrorMessage(parsed) || "Unknown error";
            accumulated += `\n[Upstream Notice: ${errMsg}]\n`;
            continue;
          }
          const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || parsed.choices?.[0]?.delta?.reasoning;
          if (reasoning) accumulatedThinking += reasoning;
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) accumulated += delta;
          const usage = extractUsage(parsed, { input: inputTokens, output: outputTokens });
          inputTokens = usage.input;
          outputTokens = usage.output;
          const cached = extractCachedTokens(parsed);
          if (cached > maxCachedTokens) maxCachedTokens = cached;
        } catch (e) {}
      }
      buffer = pos > 0 ? buffer.slice(pos) : buffer;
    }

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
      } catch (e) {
        accumulated = buffer.trim();
      }
    }
  } finally {
    reader.releaseLock();
  }

  accumulated = accumulated || " ";
  outputTokens = Math.max(outputTokens, Math.ceil((accumulated.length + accumulatedThinking.length) / 4));

  const content = [];
  if (accumulatedThinking) {
    content.push({ type: "thinking", thinking: accumulatedThinking });
  }

  // 工具调用：映射 OpenAI tool_calls 到 Anthropic tool_use content blocks
  // Anthropic tool_use.input 必须是 object；OpenAI arguments 是 JSON 字符串，需解析
  if (Array.isArray(accumulatedToolCalls) && accumulatedToolCalls.length > 0) {
    for (const tc of accumulatedToolCalls) {
      let toolInput = {};
      const rawArgs = tc.args;
      if (rawArgs && typeof rawArgs === "object") {
        toolInput = rawArgs;
      } else if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          toolInput = JSON.parse(rawArgs);
        } catch (e) {
          toolInput = {};
        }
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name || "tool",
        input: toolInput
      });
    }
  }

  content.push({ type: "text", text: accumulated });

  try { recordUpstreamCache(maxCachedTokens); } catch (e) {}

  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    content: content,
    model: requestedModel || "claude-3-5-haiku-20241022",
    stop_reason: finishReasonToAnthropic(accumulatedFinishReason),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extraHeaders }
  });
}
