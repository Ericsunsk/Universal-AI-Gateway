// 响应侧转译 —— OpenAI SSE/JSON → Anthropic SSE/JSON（I/O 侧：读流、写帧、保活、熔断）。
// 纯归约（extractors / reducer / StreamBlockState / iterSseParsedChunks）已抽至 ./reduce.js，
// 本文件只保留需要 IO 的编排：读上游流、驱动块状态机、写回客户端；路由见 ./dispatch.js。
import { corsHeaders } from "../http/headers.js";
import { redactUpstreamText } from "../http/redact.js";
import {
  extractErrorMessage, extractUsage, resolveStopDetail, resolveStopDetails,
  reduceOpenAIChunkAll, mergeSseToolFrags, toolCallsToAnthropicBlocks,
  iterSseParsedChunks, StreamBlockState, extractCachedTokens
} from "./reduce.js";
import { recordUpstreamCache } from "../core/cacheStats.js";
import { ThinkingAccumulator, shouldEmitTextBlock } from "./thinking.js";
import { DsmlStreamParser, parseDsmlInvocations, stripDsml, containsDsml } from "./dsml.js";
import { log } from "../logging/logger.js";

// 内部流式转译：OpenAI SSE -> Anthropic SSE（优化：零内存拷贝保活与事件复用）

// 上游流停滞熔断：连续该时长收不到上游任何字节即判定上游卡死（如某些模型只回 200 头然后静默），
// 主动收尾而不是让客户端挂到平台超时。只看“无字节”时长，持续吐 token 的慢模型不受影响。
// options.stallMs 供测试注入小值；生产默认 180s（< Vercel 300s 上限，远大于实测最慢模型的 118s）。
const UPSTREAM_STALL_MS = 180 * 1000;

const textEncoder = new TextEncoder();
const KEEP_ALIVE_BYTES = textEncoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n");
const EVENT_MSG_STOP_BYTES = textEncoder.encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
/**
 * 响应侧转译的**唯一出口**（命名请求包）。旧位置参数式双导出已删除，
 * 流式/非流式只是数据键（stream），不再有兄弟签名。
 * @param {object} req
 * @param {Response} req.upstream - 上游响应（其 body 会被读取）
 * @param {string} req.model - 客户端请求的模型名，用于回显
 * @param {AbortSignal|null} [req.signal] - 客户端断开信号（仅流式使用）
 * @param {object} [req.headers] - 追加到响应上的头（调用方构造，如 debug 头）
 * @param {object} [req.stopDetail] - resolveStopDetail 的返回值；省略时由 stopSequences 就地解析
 * @param {unknown} [req.stopSequences] - 原始停止序列（stopDetail 省略时使用）
 * @param {number} [req.initialInputTokens] - 首帧 input_tokens 预估（仅非流式/流式首帧）
 * @param {number} [req.stallMs] - 上游停滞熔断阈值（仅流式；生产默认 UPSTREAM_STALL_MS）
 * @param {boolean} [req.stream=true] - true 走 SSE，false 走整包 JSON
 * @returns {Response|Promise<Response>}
 */
export function encodeAnthropicResponse(req = {}) {
  const {
    upstream, model, signal = null, headers = {}, stopDetail, stopSequences,
    initialInputTokens, stallMs, stream = true
  } = req;

  if (!upstream) throw new Error("encodeAnthropicResponse: req.upstream is required");

  // 停止序列概念在此归一化一次，两个分支共用同一口径。
  const detail = stopDetail ?? resolveStopDetail(stopSequences);

  if (stream === false) {
    return formatOpenAIToAnthropicJson(upstream, model, headers, { stopDetail: detail, initialInputTokens });
  }
  return streamOpenAIToAnthropic(upstream, model, signal, headers, {
    stopDetail: detail, initialInputTokens, stallMs
  });
}

// 流式转译内部实现：OpenAI SSE → Anthropic SSE（仅经 encodeAnthropicResponse 调用，不导出）。
function streamOpenAIToAnthropic(upstreamResponse, requestedModel, clientSignal = null, extraHeaders = {}, options = {}) {
  const stallMs = Number.isFinite(options?.stallMs) && options.stallMs > 0 ? options.stallMs : UPSTREAM_STALL_MS;
  // 本次请求下发的停止序列：用于流式终局判定 stop_reason 是 stop_sequence 还是 end_turn。
  // 归一化与「是否生效」由 resolveStopDetail 唯一回答（概念归属，见该函数）。
  // 调用方若已解析（encodeAnthropicResponse）则直接透传，避免重复归一化。
  const stopDetail = options?.stopDetail ?? resolveStopDetail(options?.stopSequences);
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const sseHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "anthropic-version": "2023-06-01",
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
        usage: { input_tokens: options?.initialInputTokens || 0, output_tokens: 0 }
      }
    })}\n\n`));
    } catch {
      clearInterval(pingInterval);
      return;
    }

    const streamDecoder = new TextDecoder();
    let buffer;

    // block 状态机：取代此前散落的 currentBlockIndex/Type/ToolId/ToolName 四个可变变量。
    const blockState = new StreamBlockState(stopDetail.sequences);
    const dsmlParser = new DsmlStreamParser();
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
          // 上游错误文本不可信：日志与客户端回执都必须经 redact seam（与 dispatch 同口径），
          // 否则上游回显的内部端点 / 凭据会同时污染日志聚合与 SSE 流。
          const errMsg = redactUpstreamText(errorEmission.message);
          log.warn("Upstream stream error", { error: errMsg });
          if (blockState.blockType !== "text") await writeAll(blockState.open("text"));
          // notice 文本同样计入 emittedChars（textDelta 内部累计），与正文同口径，避免 output_tokens 偏小
          await writeAll(blockState.textDelta(`\n[Upstream Notice: ${errMsg}]\n`));
          continue;
        }

        for (const emission of emissions) {
          if (emission.kind === "text") {
            const dsmlEvents = dsmlParser.push(emission.text);
            for (const ev of dsmlEvents) {
              if (ev.type === "text") {
                await writeAll(blockState.applyEmission({ kind: "text", text: ev.text }));
              } else if (ev.type === "tool_use") {
                await writeAll(blockState.applyEmission({
                  kind: "tool_use",
                  calls: [{ id: ev.id, name: ev.name, args: JSON.stringify(ev.args), ident: true }]
                }));
              }
            }
          } else {
            // 分派收进状态机：读循环只表达「解码 → 分派 → 写出」，不再承载 kind 长链。
            // 无 delta 的纯 finish 终局块同样经此处设置 stop_reason，不得用 delta 守卫跳过。
            await writeAll(blockState.applyEmission(emission));
          }
        }
      }

      // 流读取完毕，冲洗 DSML 缓冲区中挂起的所有内容
      const flushedEvents = dsmlParser.flush();
      for (const ev of flushedEvents) {
        if (ev.type === "text") {
          await writeAll(blockState.applyEmission({ kind: "text", text: ev.text }));
        } else if (ev.type === "tool_use") {
          await writeAll(blockState.applyEmission({
            kind: "tool_use",
            calls: [{ id: ev.id, name: ev.name, args: JSON.stringify(ev.args), ident: true }]
          }));
        }
      }

      buffer = tail.text;

      // 若流结束时 buffer 尚存非 SSE 格式内容（如上游返回单一 JSON）
      if (blockState.blockIndex === -1 && buffer.trim()) {
        try {
          // 上游 error.message / 无法解析的原始 buffer 均不可信：经 redact seam 收敛后再回吐。
          // 这是流式路径上「上游返回非 SSE 整块内容」的兜底出口——此前直接把原始 buffer
          // 当正文发出，可回显上游内部端点 / 凭据（与 formatOpenAIToAnthropicJson 的兜底同源问题）。
          const parsed = JSON.parse(buffer.trim());
          const text = parsed.choices?.[0]?.message?.content ||
                       parsed.choices?.[0]?.delta?.content ||
                       (parsed.error?.message || parsed.msg
                         ? redactUpstreamText(parsed.error?.message || parsed.msg)
                         : null) ||
                       redactUpstreamText(parsed.code ? `Upstream error ${parsed.code}` : buffer.trim());
          if (text) {
            if (containsDsml(text)) {
              const dsmlInvocations = parseDsmlInvocations(text);
              const cleanText = stripDsml(text);
              if (cleanText) {
                await writeAll(blockState.open("text"));
                await writeAll(blockState.textDelta(cleanText));
              }
              for (const inv of dsmlInvocations) {
                await writeAll(blockState.applyEmission({
                  kind: "tool_use",
                  calls: [{ id: "call_" + Math.random().toString(36).substring(2, 10), name: inv.name, args: JSON.stringify(inv.args), ident: true }]
                }));
              }
            } else {
              await writeAll(blockState.open("text"));
              await writeAll(blockState.textDelta(text));
            }
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
      // 取上游 usage 与字符估算的较大值（与非流式落袋口径一致）。
      // input_tokens 采信上游 usage.prompt_tokens：缺失时为 0（不估算输入长度）。
      const finalOutputTokens = Math.max(reportedOutputTokens, Math.ceil(blockState.emittedChars / 4));
      // 终局 stop_reason 与 stop_sequence：统一委托 resolveStopDetails 判定
      const stopDetails = resolveStopDetails(blockState.stopReason, {
        text: blockState.textTail,
        detail: stopDetail
      });
      const finalInputTokens = reportedInputTokens || options?.initialInputTokens || 0;
      const usagePayload = {
        input_tokens: finalInputTokens,
        output_tokens: finalOutputTokens,
        ...(maxCachedTokens > 0 ? { cache_read_input_tokens: maxCachedTokens } : {})
      };
      await writer.write(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: stopDetails.stopReason, stop_sequence: stopDetails.stopSequence },
        usage: usagePayload
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
        const errInputTokens = reportedInputTokens || options?.initialInputTokens || 0;
        const errUsage = {
          input_tokens: errInputTokens,
          output_tokens: errOutputTokens,
          ...(maxCachedTokens > 0 ? { cache_read_input_tokens: maxCachedTokens } : {})
        };
        await writer.write(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: errUsage
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

// 非流式转译内部实现：OpenAI -> Anthropic JSON（仅经 encodeAnthropicResponse 调用，不导出）。
async function formatOpenAIToAnthropicJson(upstreamResponse, requestedModel, extraHeaders = {}, options = {}) {
  // 与非流式同口径：停止序列概念交由 resolveStopDetail 归属（见该函数）。
  // 调用方若已解析（encodeAnthropicResponse）则直接透传，避免重复归一化。
  const stopDetail = options?.stopDetail ?? resolveStopDetail(options?.stopSequences);
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  const thinkingAcc = new ThinkingAccumulator();
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
          // 同流式出口：上游原文经 redact seam 收敛后再并入正文。
          accumulated += `\n[Upstream Notice: ${redactUpstreamText(emission.message)}]\n`;
        } else if (emission.kind === "thinking") {
          thinkingAcc.push(emission.text);
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
        if (reasoning) thinkingAcc.reset(reasoning);
        if (message && message.content !== undefined && message.content !== null) {
          accumulated = message.content;
        } else if (parsed.choices?.[0]?.delta?.content) {
          accumulated = parsed.choices[0].delta.content;
        } else {
          // 上游 error.message 不可信：经 redact seam 收敛后再作为正文回吐（与流式出口同口径）。
          // 注意 extractErrorMessage 可能为 undefined，此时保留原有 fallback 链，不调用 redact
          // （redactUpstreamText 对空输入会返回固定文案，会吞掉 thinkingAcc 抑制语义）。
          const errText = extractErrorMessage(parsed);
          accumulated = (errText ? redactUpstreamText(errText) : null) || (thinkingAcc.suppressesFallbackText ? "" : redactUpstreamText(buffer.trim()));
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
        // JSON 解析失败：上游返回非预期形态，buffer 原文不可信，经 redact seam 收敛后再回吐。
        accumulated = redactUpstreamText(buffer.trim());
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

  // 拦截并解析可能泄漏在正文中的 DSML 工具调用
  if (containsDsml(accumulated)) {
    const dsmlInvocations = parseDsmlInvocations(accumulated);
    for (const inv of dsmlInvocations) {
      accumulatedToolCalls.push({
        id: "call_" + Math.random().toString(36).substring(2, 10),
        name: inv.name,
        args: inv.args
      });
    }
    accumulated = stripDsml(accumulated);
    accumulatedFinishReason = "tool_calls";
  }

  accumulated = accumulated || "";
  outputTokens = Math.max(outputTokens, Math.ceil(((accumulated || " ").length + thinkingAcc.estimatedChars()) / 4));

  const content = [];
  // thinking 块由归属模块构造（含统一签名补齐），此处只负责排布顺序。
  const thinkingBlock = thinkingAcc.toAnthropicBlock();
  if (thinkingBlock) content.push(thinkingBlock);

  // 工具调用：映射 OpenAI tool_calls 到 Anthropic tool_use content blocks
  // Anthropic tool_use.input 必须是 object；OpenAI arguments 是 JSON 字符串，需解析
  // accumulatedToolCalls 到 Anthropic tool_use content blocks
  if (Array.isArray(accumulatedToolCalls) && accumulatedToolCalls.length > 0) {
    content.push(...toolCallsToAnthropicBlocks(accumulatedToolCalls));
  }

  // 「何时输出 text 块」的唯一规则，归 thinking 模块（见 shouldEmitTextBlock）。
  if (shouldEmitTextBlock(accumulated, content)) {
    content.push({ type: "text", text: accumulated || " " });
  }

  try { recordUpstreamCache(maxCachedTokens); } catch {}

  // 停序列命中判定：统一委托 resolveStopDetails 判定
  const stopDetails = resolveStopDetails(accumulatedFinishReason, {
    text: accumulated,
    detail: stopDetail
  });

  const finalInputTokens = inputTokens || options?.initialInputTokens || 0;
  const jsonUsage = {
    input_tokens: finalInputTokens,
    output_tokens: outputTokens,
    ...(maxCachedTokens > 0 ? { cache_read_input_tokens: maxCachedTokens } : {})
  };

  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    content: content,
    model: requestedModel || "claude-3-5-haiku-20241022",
    stop_reason: stopDetails.stopReason,
    stop_sequence: stopDetails.stopSequence,
    usage: jsonUsage
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "anthropic-version": "2023-06-01",
      ...corsHeaders,
      ...extraHeaders
    }
  });
}
