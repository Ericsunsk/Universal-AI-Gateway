import { buildResponseHeaders } from "../http/headers.js";

export class OpenCodeProvider {
  constructor(config, env) {
    this.id = config.id || "opencode";
    this.name = config.name || "OpenCode Zen (Free Tier)";
    this.type = "opencode";
    this.env = env;
    this.config = config.config || {};
  }

  get baseUrl() {
    let url = this.config.baseUrl || "https://opencode.ai/zen/v1";
    return url.replace(/\/$/, "");
  }

  async callChat(payload, options = {}) {
    // 自动适配：muse-spark 在 OpenCode Zen 后端仅部署于 /zen/v1/responses 端点
    if (payload.model && payload.model.includes("muse-spark")) {
      return this.callResponsesApi(payload, options);
    }

    const url = `${this.baseUrl}/chat/completions`;
    const sessionId = options.sessionId || crypto.randomUUID();
    const requestId = crypto.randomUUID();

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "opencode/1.18.30",
      "x-opencode-session": sessionId,
      "x-opencode-request": requestId,
      "x-opencode-client": "cli",
      "Accept": payload.stream !== false ? "text/event-stream, application/json" : "application/json",
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      signal: options.signal,
      keepalive: true
    });

    if (resp.ok) {
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: buildResponseHeaders(resp.headers, {
          "X-Gateway-Account": "opencode-zen",
          "X-Gateway-Account-Id": "opencode-zen"
        })
      });
    }

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

  async callResponsesApi(payload, options = {}) {
    const url = `${this.baseUrl}/responses`;
    const sessionId = options.sessionId || crypto.randomUUID();
    const requestId = crypto.randomUUID();

    let targetModel = payload.model;
    if (targetModel === "muse-spark-1.3") targetModel = "muse-spark-1.3-contributor-free";
    if (targetModel === "muse-spark-1.2") targetModel = "muse-spark-1.2-contributor-free";

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "opencode/1.18.30",
      "x-opencode-session": sessionId,
      "x-opencode-request": requestId,
      "x-opencode-client": "cli",
      "Accept": payload.stream !== false ? "text/event-stream, application/json" : "application/json",
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    const isStream = payload.stream !== false;
    const responsesPayload = {
      model: targetModel,
      input: payload.messages,
      stream: isStream
    };
    if (payload.temperature !== undefined) responsesPayload.temperature = payload.temperature;
    if (payload.top_p !== undefined) responsesPayload.top_p = payload.top_p;
    if (payload.max_tokens !== undefined) responsesPayload.max_output_tokens = payload.max_tokens;

    const resp = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(responsesPayload),
      signal: options.signal,
      keepalive: true
    });

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

    if (!isStream) {
      const json = await resp.json();
      let text = "";
      for (const item of (json.output || [])) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "output_text" && part.text) {
              text += part.text;
            }
          }
        }
      }

      const openaiJson = {
        id: json.id || ("chatcmpl-" + crypto.randomUUID()),
        object: "chat.completion",
        created: json.created_at || Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text
            },
            finish_reason: "stop"
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
        headers: buildResponseHeaders(resp.headers, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Gateway-Account": "opencode-zen",
          "X-Gateway-Account-Id": "opencode-zen"
        })
      });
    }

    // 将 Responses API 的 SSE 流实时转译为标准 OpenAI SSE 流
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      const reader = resp.body.getReader();
      let buffer = "";
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
              if (parsed.type === "response.output_text.delta" && parsed.delta) {
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
              } else if (parsed.type === "response.completed") {
                await writer.write(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`));
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
      headers: buildResponseHeaders(resp.headers, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Gateway-Account": "opencode-zen",
        "X-Gateway-Account-Id": "opencode-zen"
      })
    });
  }

  async getBalance() {
    return {
      success: true,
      balance: "∞ (Free Tier)",
      total: "∞",
      unit: "次",
      accounts_count: 1,
      extra: "OpenCode Zen (Free Models: mimo-v2.5-free, ling-3.0-flash-fin-free, big-pickle, etc.)"
    };
  }

  async onSchedule() {
    // 免登录免费模型无需维护 Token 或定时签到
  }
}
