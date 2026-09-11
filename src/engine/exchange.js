export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

// 模块级单例 Encoder / Decoder 与预编码静态 Buffer（零 GC 内存分配）
const textEncoder = new TextEncoder();
const KEEP_ALIVE_BYTES = textEncoder.encode(": keep-alive\n\n");
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

// 内部协议工具：Anthropic 请求体 -> OpenAI 请求体
function transformAnthropicToOpenAI(body, targetModel) {
  const model = targetModel || body.model || "deepseek-v4.1-flash";
  const openaiMessages = [];

  if (body.system) {
    const sysText = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(s => s.text || "").join("\n")
        : String(body.system);
    openaiMessages.push({ role: "system", content: sysText });
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === "string") {
        openaiMessages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content
        });
      } else if (Array.isArray(msg.content)) {
        const toolUseBlocks = msg.content.filter(b => b.type === "tool_use");
        const toolResultBlocks = msg.content.filter(b => b.type === "tool_result");
        const textBlocks = msg.content.filter(b => b.type === "text" || !b.type);

        if (msg.role === "assistant" && toolUseBlocks.length > 0) {
          const textContent = textBlocks.map(b => b.text || "").join("\n");
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
            content: textContent || null,
            tool_calls: toolCalls
          });
        } else if (toolResultBlocks.length > 0) {
          for (const rb of toolResultBlocks) {
            const resContent = typeof rb.content === "string" ? rb.content : JSON.stringify(rb.content || "");
            openaiMessages.push({
              role: "tool",
              tool_call_id: rb.tool_use_id,
              content: resContent
            });
          }
        } else {
          const combined = textBlocks.map(b => b.text || "").join("\n");
          openaiMessages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: combined
          });
        }
      }
    }
  }

  const upstreamTools = transformToolsToOpenAI(body.tools);
  const payload = {
    model: model,
    messages: openaiMessages,
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
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.replace(/^data:\s*/, "");
          if (jsonStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(jsonStr);
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
              await writer.write(textEncoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "thinking_delta", thinking: reasoningChunk }
              })}\n\n`));
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
              await writer.write(textEncoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: currentBlockIndex,
                delta: { type: "text_delta", text: textChunk }
              })}\n\n`));
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
                  await writer.write(textEncoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: currentBlockIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments
                    }
                  })}\n\n`));
                }
              }
            }

            if (parsed.choices?.[0]?.finish_reason === "tool_calls") {
              finalStopReason = "tool_use";
            }
          } catch (e) {}
        }
      }

      await closeCurrentBlock();

      await writer.write(textEncoder.encode(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: finalStopReason, stop_sequence: null },
        usage: { output_tokens: 60 }
      })}\n\n`));

      await writer.write(EVENT_MSG_STOP_BYTES);
    } finally {
      clearInterval(pingInterval);
      await writer.close();
    }
  })().catch(err => {
    writer.abort(err);
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

// 内部非流式转译：OpenAI -> Anthropic JSON
async function formatOpenAIToAnthropicJson(upstreamResponse, requestedModel) {
  const msgId = "msg_" + Math.random().toString(36).substring(2, 15);
  const rawText = await upstreamResponse.text();

  let accumulated = "";
  if (rawText.includes("data:")) {
    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.replace(/^data:\s*/, "");
      if (jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        accumulated += parsed.choices?.[0]?.delta?.content || "";
      } catch (e) {}
    }
  } else {
    try {
      const parsed = JSON.parse(rawText);
      accumulated = parsed.choices?.[0]?.message?.content || "";
    } catch (e) {
      accumulated = rawText;
    }
  }

  return new Response(JSON.stringify({
    id: msgId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: accumulated }],
    model: requestedModel || "claude-3-5-sonnet-20241022",
    stop_reason: "end_turn",
    usage: { input_tokens: 15, output_tokens: 60 }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders }
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
  let candidates = routes[model];

  // 路由模糊回退
  if (!candidates || candidates.length === 0) {
    if (model.includes("haiku")) {
      candidates = routes["deepseek-v4-flash"] || [{ provider: "workbuddy", model: "deepseek-v4-flash" }];
    } else if (model.includes("opus")) {
      candidates = routes["deepseek-v4-pro"] || [{ provider: "workbuddy", model: "deepseek-v4-pro" }];
    } else if (model.includes("sonnet") || model.includes("claude")) {
      candidates = routes["deepseek-v4.1-flash"] || [{ provider: "workbuddy", model: "deepseek-v4.1-flash" }];
    } else {
      candidates = [{ provider: "workbuddy", model: model }];
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
          const openaiPayload = transformAnthropicToOpenAI(body, candidate.model);
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
