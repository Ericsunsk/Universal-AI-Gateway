import { stripAnsi } from "./sanitizer.js";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

// 模块级单例 Encoder / Decoder 与预编码静态 Buffer（零 GC 内存分配）
const textEncoder = new TextEncoder();
const KEEP_ALIVE_BYTES = textEncoder.encode("event: ping\ndata: {\"type\":\"ping\"}\n\n");
const EVENT_MSG_STOP_BYTES = textEncoder.encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");

// 内部协议工具：Tools 转换
function transformToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} }
    }
  }));
}

// 核心状态机规范化：重构并对齐 OpenAI tool_calls 与 tool_results 顺序（根除 11148 tool_call_sequence_broken）
function normalizeOpenAIMessages(messages) {
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
        content: `[Tool Result: ${m.content}]`
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

/**
 * 智能上下文窗口剪枝与管理：
 * 1. 彻底根治超长会话（如 Claude Code 累积数十上百轮、上千条消息）在 Cloudflare Workers 触发 1102 (CPU/Memory Limit) 致命错误。
 * 2. 对长会话智能截取“首轮任务意图 + 最近活跃上下文”，并严格保证切片位于干净的 user 轮次，避免工具调用序列破坏 (11148)。
 * 3. 对历史工具执行结果（tool_result）的大块冗余终端输出进行两端保留式剪枝。
 */
function pruneMessageContents(messages, isCompact, recentSafeTurns = 15) {
  const total = messages.length;
  return messages.map((msg, idx) => {
    if (!msg || !Array.isArray(msg.content)) return msg;
    const isOlder = (total - idx) > recentSafeTurns;
    let modified = false;
    const newContent = msg.content.map(part => {
      if (!part || typeof part !== "object") return part;
      if (part.type === "tool_result") {
        let text = typeof part.content === "string" ? part.content : (
          Array.isArray(part.content) ? part.content.map(c => typeof c === "string" ? c : (c.text || JSON.stringify(c))).join("\n") : JSON.stringify(part.content || "")
        );
        const cleaned = stripAnsi(text);
        if (cleaned !== text) {
          text = cleaned;
          modified = true;
        }
        if (isCompact && text.length > 200) {
          modified = true;
          return { ...part, content: text.slice(0, 100) + "\n...[output truncated for summary]...\n" + text.slice(-50) };
        }
        if (isOlder && text.length > 800) {
          modified = true;
          const omitted = text.length - 350;
          return {
            ...part,
            content: text.slice(0, 250) + `\n...[Gateway Notice: ${omitted} chars of historical tool output collapsed to optimize context & latency]...\n` + text.slice(-100)
          };
        }
        if (modified) {
          return { ...part, content: text };
        }
      }
      return part;
    });
    return modified ? { ...msg, content: newContent } : msg;
  });
}

function pruneAnthropicMessages(messages, isCompact, maxTurnsLimit = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // 当 maxTurnsLimit <= 0 时，保留全部会话轮次，但仍执行工具结果清洗（移除 ANSI 干扰码及对超长远古工具输出智能两端折叠）
  if (maxTurnsLimit <= 0) {
    return pruneMessageContents(messages, isCompact, 15);
  }

  const total = messages.length;
  const maxWindow = isCompact ? Math.max(maxTurnsLimit * 1.5, 70) : maxTurnsLimit;
  if (total <= maxWindow) return pruneMessageContents(messages, isCompact, 15);

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

  return pruneMessageContents([firstMsg, bridgeMsg, ...recentMsgs], isCompact, 12);
}

// 内部协议工具：Anthropic 请求体 -> OpenAI 请求体
function transformAnthropicToOpenAI(body, targetModel, config = {}) {
  const model = targetModel || body.model || "deepseek-v4.1-flash";
  const openaiMessages = [];

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const totalMessages = rawMessages.length;
  const lastMsg = totalMessages > 0 ? rawMessages[totalMessages - 1] : null;
  const lastText = lastMsg && typeof lastMsg.content === "string" ? lastMsg.content : (
    Array.isArray(lastMsg?.content) ? lastMsg.content.map(c => c.text || "").join(" ") : ""
  );

  // 检测是否为会话压缩 / 总结请求（如 Claude Code /compact）
  const isCompact = (typeof body.system === "string" && (
    body.system.includes("Respond with TEXT ONLY") ||
    body.system.includes("<analysis>") ||
    body.system.includes("<summary>")
  )) || (
    lastText.includes("Respond with TEXT ONLY") ||
    lastText.includes("Do NOT use Read, Bash, Grep") ||
    lastText.includes("<analysis>")
  );

  // 动态上下文保留策略：Vercel / Node 环境下默认 0（完全不剪枝，长上下文保真），Cloudflare Workers 免费版环境下默认 40
  const maxTurns = config?.max_context_turns !== undefined
    ? config.max_context_turns
    : (typeof process !== "undefined" && process.env?.MAX_CONTEXT_TURNS !== undefined
        ? parseInt(process.env.MAX_CONTEXT_TURNS, 10)
        : (typeof process !== "undefined" && (process.env?.VERCEL || process.env?.NODE_ENV) ? 0 : 40));

  const messages = pruneAnthropicMessages(rawMessages, isCompact, maxTurns);

  if (body.system) {
    const sysText = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(s => s.text || "").join("\n")
        : String(body.system);
    openaiMessages.push({ role: "system", content: sysText });
  }

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (!msg) continue;

    if (typeof msg.content === "string") {
      openaiMessages.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content
      });
    } else if (Array.isArray(msg.content)) {
      const toolUseBlocks = [];
      const toolResultBlocks = [];
      const textBlocks = [];

      for (let i = 0; i < msg.content.length; i++) {
        const b = msg.content[i];
        if (!b) continue;
        if (b.type === "tool_use") toolUseBlocks.push(b);
        else if (b.type === "tool_result") toolResultBlocks.push(b);
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
        openaiMessages.push({
          role: "assistant",
          content: textContent,
          tool_calls: toolCalls
        });
      } else if (toolResultBlocks.length > 0) {
        for (let i = 0; i < toolResultBlocks.length; i++) {
          const rb = toolResultBlocks[i];
          let resContent = "";
          if (typeof rb.content === "string") {
            resContent = rb.content;
          } else if (Array.isArray(rb.content)) {
            resContent = rb.content.map(c => typeof c === "string" ? c : (c.text || JSON.stringify(c))).join("\n");
          } else {
            resContent = JSON.stringify(rb.content || "");
          }

          openaiMessages.push({
            role: "tool",
            tool_call_id: rb.tool_use_id,
            content: resContent
          });
        }
      } else {
        let combined = "";
        if (textBlocks.length === 1) {
          combined = textBlocks[0].text || "";
        } else if (textBlocks.length > 1) {
          combined = textBlocks.map(b => b.text || "").join("\n");
        }
        openaiMessages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: combined
        });
      }
    }
  }

  // 若为总结压缩请求，剥离 tools 定义避免上游大模型生成 tool_calls 反射
  const upstreamTools = isCompact ? undefined : transformToolsToOpenAI(body.tools);
  const payload = {
    model: model,
    messages: normalizeOpenAIMessages(openaiMessages),
    stream: body.stream !== false
  };

  if (upstreamTools && upstreamTools.length > 0) {
    payload.tools = upstreamTools;
    payload.tool_choice = "auto";
  }

  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  if (body.top_p !== undefined) payload.top_p = body.top_p;

  return payload;
}

// 内部流式转译：OpenAI SSE -> Anthropic SSE（优化：零内存拷贝保活与事件复用）
function streamOpenAIToAnthropic(upstreamResponse, requestedModel, clientSignal = null) {
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    let pingInterval = setInterval(async () => {
      try {
        await writer.write(KEEP_ALIVE_BYTES);
      } catch (e) {}
    }, 4000);

    // 监听客户端主动中断取消（Ctrl+C / 停止生成），级联终止上游读取与保活定时器
    if (clientSignal) {
      clientSignal.addEventListener("abort", () => {
        clearInterval(pingInterval);
        try { writer.abort(new Error("Client aborted")); } catch (e) {}
      });
    }

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

    const reader = upstreamResponse.body.getReader();
    const streamDecoder = new TextDecoder();
    let buffer = "";

    let currentBlockIndex = -1;
    let currentBlockType = null;
    let currentToolId = null;
    let currentToolName = null;
    let finalStopReason = "end_turn";

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

            // 检查上游是否嵌入了业务错误（如 Tencent code !== 0 或 error 字段）
            const isError = parsed.error || (parsed.code !== undefined && parsed.code !== 0);
            if (isError) {
              const errMsg = parsed.error?.message || parsed.msg || parsed.message || (parsed.code ? `Upstream error code ${parsed.code}` : "Unknown error");
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

            // 思维链 (DeepSeek reasoning_content)
            const reasoningChunk = delta.reasoning_content || "";
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
      if (currentBlockIndex === -1) {
        currentBlockIndex = 0;
        await writer.write(textEncoder.encode(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`));
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
      try { await writer.close(); } catch (e) {}
    }
  })().catch(err => {
    try { writer.abort(err); } catch (e) {}
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...corsHeaders
    }
  });
}

// 内部非流式转译：OpenAI -> Anthropic JSON (优化：增量流式读取，零全量内存拷贝)
async function formatOpenAIToAnthropicJson(upstreamResponse, requestedModel) {
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";
  let inputTokens = 20;
  let outputTokens = 1;

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
          if (parsed.error || (parsed.code !== undefined && parsed.code !== 0)) {
            const errMsg = parsed.error?.message || parsed.msg || parsed.message || (parsed.code ? `Upstream error ${parsed.code}` : "Unknown error");
            accumulated += `\n[Upstream Notice: ${errMsg}]\n`;
            continue;
          }
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) accumulated += delta;
          if (parsed.usage) {
            if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
            if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
          }
        } catch (e) {}
      }
      buffer = pos > 0 ? buffer.slice(pos) : buffer;
    }

    if (!accumulated && buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        accumulated = parsed.choices?.[0]?.message?.content ||
                      parsed.choices?.[0]?.delta?.content ||
                      parsed.error?.message ||
                      parsed.msg ||
                      buffer.trim();
        if (parsed.usage) {
          if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
          if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
        }
      } catch (e) {
        accumulated = buffer.trim();
      }
    }
  } finally {
    reader.releaseLock();
  }

  accumulated = accumulated || " ";
  outputTokens = Math.max(outputTokens, Math.ceil(accumulated.length / 4));

  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: accumulated }],
    model: requestedModel || "claude-3-5-haiku-20241022",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
  });
}

/**
 * Deep Exchange Module:
 * 单一深度接口，封装完整的协议探测、跨协议转译、指纹清洗、优先级回退与流式输出
 */
export async function dispatchExchange({
  protocol,
  model,
  body,
  fleet,
  config,
  request
}) {
  const isAnthropic = protocol === "anthropic";
  const routes = config.routes || {};
  // 自动剥离类似 [1M]、[200k] 等 Claude Code / 客户端附带的上下文窗口后缀
  const cleanModel = (model || "deepseek-v4.1-flash").replace(/\[.*?\]$/, "").trim();
  let candidates = routes[model] || routes[cleanModel];

  // 路由模糊回退
  if (!candidates || candidates.length === 0) {
    if (cleanModel.includes("haiku")) {
      candidates = routes["deepseek-v4-flash"] || [{ provider: "workbuddy", model: "deepseek-v4-flash" }];
    } else if (cleanModel.includes("opus")) {
      candidates = routes["deepseek-v4-pro"] || [{ provider: "workbuddy", model: "deepseek-v4-pro" }];
    } else if (cleanModel.includes("sonnet") || cleanModel.includes("claude") || cleanModel === "default") {
      candidates = routes["deepseek-v4.1-flash"] || [{ provider: "workbuddy", model: "deepseek-v4.1-flash" }];
    } else if (cleanModel.startsWith("deepseek-v4-flash")) {
      candidates = routes["deepseek-v4-flash"] || [{ provider: "workbuddy", model: "deepseek-v4-flash" }];
    } else if (cleanModel.startsWith("deepseek-v4.1-flash")) {
      candidates = routes["deepseek-v4.1-flash"] || [{ provider: "workbuddy", model: "deepseek-v4.1-flash" }];
    } else if (cleanModel.startsWith("deepseek-v4-pro")) {
      candidates = routes["deepseek-v4-pro"] || [{ provider: "workbuddy", model: "deepseek-v4-pro" }];
    } else {
      candidates = [{ provider: "workbuddy", model: cleanModel }];
    }
  }

  let lastError = null;
  let lastResponse = null;

  for (const candidate of candidates) {
    const provider = fleet.getProvider(candidate.provider);
    if (!provider) continue;

    try {
      let upstreamRes = null;

      if (isAnthropic) {
        if (provider.type === "anthropic") {
          upstreamRes = await provider.callMessages({ ...body, model: candidate.model }, { signal: request?.signal });
        } else {
          const openaiPayload = transformAnthropicToOpenAI(body, candidate.model, config);
          if (provider.type === "workbuddy") {
            openaiPayload.stream = true;
          }
          upstreamRes = await provider.callChat(openaiPayload, { signal: request?.signal });
        }
      } else {
        const openaiPayload = { ...body, model: candidate.model };
        if (provider.type === "workbuddy") {
          openaiPayload.stream = true;
        }
        upstreamRes = await provider.callChat(openaiPayload, { signal: request?.signal });
      }

      if (upstreamRes && upstreamRes.ok) {
        if (isAnthropic && provider.type !== "anthropic") {
          if (body.stream !== false) {
            return streamOpenAIToAnthropic(upstreamRes, model, request?.signal);
          } else {
            return await formatOpenAIToAnthropicJson(upstreamRes, model);
          }
        }

        return new Response(upstreamRes.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            ...(upstreamRes.headers.get("content-type") ? { "Content-Type": upstreamRes.headers.get("content-type") } : {})
          }
        });
      }

      if (upstreamRes) {
        lastResponse = upstreamRes;
        const status = upstreamRes.status;
        if (status === 429 || status >= 500) {
          console.warn(`[Fallback] Provider "${candidate.provider}" returned ${status}, retrying next candidate...`);
          continue;
        }

        // 优化：直接读取错误文本，无需多余 clone() 避免额外内存拷贝
        const errText = await upstreamRes.text();
        if (errText.includes("11128") || errText.includes("rate limit") || errText.includes("quota")) {
          console.warn(`[Fallback] Provider "${candidate.provider}" quota/filter triggered, retrying next candidate...`);
          continue;
        }

        return new Response(errText, {
          status: status,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    } catch (err) {
      console.warn(`[Fallback] Provider "${candidate.provider}" failed: ${err.message}, retrying next candidate...`);
      lastError = err;
    }
  }

  if (lastResponse) {
    const errText = await lastResponse.text();
    return new Response(errText, {
      status: lastResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }

  return new Response(JSON.stringify({
    error: {
      message: `All available providers for model "${model}" failed. Last error: ${lastError ? lastError.message : "none"}`
    }
  }), {
    status: 502,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
