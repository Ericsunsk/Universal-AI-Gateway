// Responses 协议 —— /zen/v1/responses 的请求组装与 OpenAI 回译（JSON + SSE）。
// 纯转译，无实例状态；代理重试循环是实例行为，仍留在 provider 方法内。
import { buildResponseHeaders } from "../../http/headers.js";

/**
 * 将 OpenAI 格式的 messages 转换为 OpenCode /zen/v1/responses 所需的 input 列表
 * - 支持 user, system, assistant 文本消息 (确保 content 为字符串且非 null)
 * - 支持 assistant.tool_calls 拆解为 function_call 节点
 * - 支持 role: "tool" 转换为 function_call_output 节点
 * - 自动成对闭合 function_call 与 function_call_output，防止上游 400 报错
 */
export function transformOpenAIMessagesToResponsesInput(messages) {
  if (!Array.isArray(messages)) return [];

  const input = [];
  const emittedCallIds = new Set();
  const pendingCallIds = new Set();

  for (const msg of messages) {
    if (!msg) continue;

    // 1. 处理 tool 角色（工具执行结果转换为 function_call_output）
    if (msg.role === "tool") {
      const callId = msg.tool_call_id || (msg.id ? String(msg.id) : null) || `call_anon_${input.length}`;
      let contentStr = "";
      if (typeof msg.content === "string") {
        contentStr = msg.content;
      } else if (Array.isArray(msg.content)) {
        contentStr = msg.content.map(c => typeof c === "string" ? c : (c.text || JSON.stringify(c))).join("\n");
      } else if (msg.content !== null && msg.content !== undefined) {
        contentStr = JSON.stringify(msg.content);
      }

      // Responses API 强制要求：每个 function_call_output 前面必须有相同 call_id 的 function_call
      if (!emittedCallIds.has(callId)) {
        input.push({
          type: "function_call",
          call_id: callId,
          name: "tool",
          arguments: "{}"
        });
        emittedCallIds.add(callId);
      }

      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentStr
      });
      pendingCallIds.delete(callId);
      continue;
    }

    // 2. 处理 assistant 角色（包含普通文本以及 tool_calls）
    if (msg.role === "assistant") {
      let textContent = "";
      if (typeof msg.content === "string") {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        textContent = msg.content.map(c => typeof c === "string" ? c : (c.text || "")).join("\n").trim();
      }

      if (textContent) {
        input.push({
          role: "assistant",
          content: textContent
        });
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const callId = tc.id || `call_${crypto.randomUUID().slice(0, 8)}`;
          const funcName = tc.function?.name || tc.name || "tool";
          const args = typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || tc.arguments || {});

          emittedCallIds.add(callId);
          pendingCallIds.add(callId);
          input.push({
            type: "function_call",
            call_id: callId,
            name: funcName,
            arguments: args
          });
        }
      } else if (!textContent) {
        // 保证 content 为字符串而非 null，防止上游 400 content did not match any supported type
        input.push({
          role: "assistant",
          content: ""
        });
      }
      continue;
    }

    // 3. 处理 user / system / developer 等常规角色
    const role = (msg.role === "developer" || msg.role === "system") ? "system" : "user";
    let contentStr = "";
    if (typeof msg.content === "string") {
      contentStr = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentStr = msg.content.map(c => typeof c === "string" ? c : (c.text || JSON.stringify(c))).join("\n");
    } else if (msg.content !== null && msg.content !== undefined) {
      contentStr = String(msg.content);
    }

    input.push({
      role: role,
      content: contentStr
    });
  }

  // 4. 清理遗留未闭合的 function_call
  for (const pendingId of pendingCallIds) {
    input.push({
      type: "function_call_output",
      call_id: pendingId,
      output: "[Completed]"
    });
  }

  return input;
}

// 组装 Responses 请求体（透传 tools / tool_choice / 推理参数）。
export function buildResponsesPayload(payload, targetModel) {
const isStream = payload.stream !== false;
const responsesPayload = {
  model: targetModel,
  input: transformOpenAIMessagesToResponsesInput(payload.messages),
  stream: isStream
};
if (payload.temperature !== undefined) responsesPayload.temperature = payload.temperature;
if (payload.top_p !== undefined) responsesPayload.top_p = payload.top_p;
if (payload.max_tokens !== undefined) {
  responsesPayload.max_output_tokens = Math.max(payload.max_tokens, 1024);
}
if (payload.reasoning) {
  responsesPayload.reasoning = payload.reasoning;
} else if (payload.reasoning_effort) {
  responsesPayload.reasoning = { effort: payload.reasoning_effort };
}

// Claude Code Tool Calling 深度支持：透传 tools 与 tool_choice 到 Responses API
if (Array.isArray(payload.tools) && payload.tools.length > 0) {
  responsesPayload.tools = payload.tools.map(t => {
    if (t.type === "function" && t.function) {
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters || {}
      };
    }
    return t;
  });
  if (payload.tool_choice) {
    responsesPayload.tool_choice = payload.tool_choice;
  }
}
  return { responsesPayload, isStream };
}

// 上游非 2xx：原文透传并打上网关账号头。
export async function renderResponsesUpstreamError(resp) {
if (!resp.ok) {
  const errText = await resp.text();
  return new Response(errText, {
    status: resp.status,
    headers: buildResponseHeaders(resp.headers, {
      "Content-Type": "application/json",
      "X-Gateway-Account": "opencode-zen",
      "X-Gateway-Account-Id": "opencode-zen"
    })
  });
}
}

// 非流式 Responses JSON → OpenAI chat.completion。
export function translateResponsesJsonToOpenAI(json, { model, elapsed, upstreamHeaders }) {
  let text = "";
  const toolCalls = [];

  for (const item of (json.output || [])) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          text += part.text;
        }
      }
    } else if (item.type === "function_call" || item.type === "tool_call") {
      toolCalls.push({
        id: item.call_id || item.id || `call_${crypto.randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: item.name || item.function?.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      });
    }
  }

  const openaiMessage = { role: "assistant", content: text || null };
  if (toolCalls.length > 0) {
    openaiMessage.tool_calls = toolCalls;
  }

  const openaiJson = {
    id: json.id || ("chatcmpl-" + crypto.randomUUID()),
    object: "chat.completion",
    created: json.created_at || Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: openaiMessage,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
      }
    ],
    usage: {
      prompt_tokens: json.usage?.input_tokens || 15,
      completion_tokens: json.usage?.output_tokens || 10,
      total_tokens: json.usage?.total_tokens || 25
    }
  };

  return new Response(JSON.stringify(openaiJson), {
    status: 200,
    headers: buildResponseHeaders(upstreamHeaders, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Gateway-Account": "opencode-zen",
      "X-Gateway-Account-Id": "opencode-zen",
      "X-Gateway-Latency": `${elapsed}ms`
    })
  });
}

// Responses SSE → OpenAI SSE（text 与 tool_calls 实时转译）。
export function translateResponsesStreamToOpenAI(upstreamBody, { elapsed, upstreamHeaders }) {
// 将 Responses API 的 SSE 流实时转译为标准 OpenAI SSE 流（支持 text 和 tool_calls）
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

(async () => {
  const reader = upstreamBody.getReader();
  let buffer = "";
  let hasToolCalls = false;

  const emittedTextKeys = new Set();
  const emittedArgsKeys = new Set();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let pos = 0, lineEnd;
      while ((lineEnd = buffer.indexOf("\n", pos)) !== -1) {
        const line = buffer.slice(pos, lineEnd).trim();
        pos = lineEnd + 1;
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const parsed = JSON.parse(raw);

          // 1. 推理思考开始：立即发射 thinking 增量，防止客户端触发「首块无内容超时」回退
          if (parsed.type === "response.output_item.added" && parsed.item?.type === "reasoning") {
            const chunk = {
              choices: [
                {
                  delta: {
                    reasoning_content: " "
                  }
                }
              ]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // 2. 正文流式增量
          else if (parsed.type === "response.output_text.delta" && parsed.delta) {
            const key = `${parsed.output_index ?? 0}_${parsed.content_index ?? 0}`;
            emittedTextKeys.add(key);
            const openaiChunk = {
              choices: [
                {
                  delta: {
                    content: parsed.delta
                  }
                }
              ]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
          }

          // 3. 消息块完成兜底：若部分上游模型直接在 output_item.done 中打包文本，确保不漏发
          else if (parsed.type === "response.output_item.done" && parsed.item?.type === "message") {
            if (Array.isArray(parsed.item.content)) {
              for (let ci = 0; ci < parsed.item.content.length; ci++) {
                const part = parsed.item.content[ci];
                const key = `${parsed.output_index ?? 0}_${ci}`;
                if (!emittedTextKeys.has(key) && part.type === "output_text" && part.text) {
                  emittedTextKeys.add(key);
                  const openaiChunk = {
                    choices: [{ delta: { content: part.text } }]
                  };
                  await writer.write(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
                }
              }
            }
          }

          // 4. 工具调用开始 (function_call)
          else if (parsed.type === "response.output_item.added" && parsed.item?.type === "function_call") {
            hasToolCalls = true;
            const callId = parsed.item.call_id || parsed.item.id || `call_${crypto.randomUUID().slice(0, 8)}`;
            const chunk = {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: parsed.output_index || 0,
                        id: callId,
                        type: "function",
                        function: {
                          name: parsed.item.name || "tool",
                          arguments: ""
                        }
                      }
                    ]
                  }
                }
              ]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // 5. 工具调用参数增量
          else if (parsed.type === "response.function_call_arguments.delta") {
            hasToolCalls = true;
            const key = `${parsed.output_index ?? 0}`;
            emittedArgsKeys.add(key);
            const chunk = {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: parsed.output_index || 0,
                        function: {
                          arguments: parsed.delta || ""
                        }
                      }
                    ]
                  }
                }
              ]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }

          // 6. 工具调用完成兜底参数
          else if (parsed.type === "response.output_item.done" && parsed.item?.type === "function_call") {
            hasToolCalls = true;
            const key = `${parsed.output_index ?? 0}`;
            if (!emittedArgsKeys.has(key) && parsed.item.arguments) {
              emittedArgsKeys.add(key);
              const chunk = {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: parsed.output_index || 0,
                          function: {
                            arguments: typeof parsed.item.arguments === "string"
                              ? parsed.item.arguments
                              : JSON.stringify(parsed.item.arguments)
                          }
                        }
                      ]
                    }
                  }
                ]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }

          // 7. 完成事件
          else if (parsed.type === "response.completed") {
            const finishReason = hasToolCalls ? "tool_calls" : "stop";
            await writer.write(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`));
          }
        } catch (e) {}
      }
      buffer = pos > 0 ? buffer.slice(pos) : buffer;
    }
    await writer.write(encoder.encode("data: [DONE]\n\n"));
  } catch (err) {
    try { await writer.abort(err); } catch (e) {}
  } finally {
    try { await writer.close(); } catch (e) {}
  }
})();

return new Response(readable, {
  status: 200,
  headers: buildResponseHeaders(upstreamHeaders, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Gateway-Account": "opencode-zen",
    "X-Gateway-Account-Id": "opencode-zen",
    "X-Gateway-Latency": `${elapsed}ms`
  })
});
}
