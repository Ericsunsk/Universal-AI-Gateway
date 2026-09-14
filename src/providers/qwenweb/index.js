// Qwen 网页版 provider —— chat.qwen.ai 的网关适配。
//
// v1 取舍（诚实记录）：
// - 每网关请求开一个新 chat，OpenAI messages[] 历史压成单轮 user 文本（role 标注保留），
//   只打一次上游 SSE。相对“逐轮回放链”省 N-1 次调用；代价是 tool_calls 结构变文本（qwen 网页通道本就无函数调用）。
// - 历史放尾部追加，前缀字节稳定；若上游按内容做前缀缓存则天然命中。
// - 鉴权重放账号配置的 cookie + 指纹头（fingerprint.js），不做加解密逆向；
//   指纹失效表现为 WAF 拦截 → 本模块统一判 429 → 网关冷却漂移 + 人工刷新指纹。
// - 多账号 = 多个 provider 条目（id 不同），经 routes 候选做模型级故障转移；本模块只管单账号。
import {
  QWENWEB_DEFAULT_BASE_URL,
  parseChatNew,
  splitHistory,
  truncateHistory,
  buildTurn,
  buildCompletionsBody,
  parseQwenSSEObject,
  isWAFStatus,
  isWAFBody
} from "./protocol.js";
import { buildQwenHeaders } from "./fingerprint.js";
import { assembleRequestHeaders, generateDeviceId } from "./antiBot.js";
import { buildResponseHeaders } from "../../http/headers.js";

// bx-umidtoken 抓取缓存（对齐上游 100 次一换；进程级，失败则降级为不带该头）。
let cachedMidtoken = null;
let midtokenUses = 0;

async function fetchMidtoken(fetchImpl) {
  if (cachedMidtoken && midtokenUses < 100) {
    midtokenUses += 1;
    return cachedMidtoken;
  }
  try {
    const res = await fetchImpl("https://sg-wum.alibaba.com/w/wu.json", { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    const m = text.match(/(?:umx\.wu|__fycb)\('([^']+)'\)/);
    if (m) {
      cachedMidtoken = m[1];
      midtokenUses = 0;
      return cachedMidtoken;
    }
  } catch (e) {}
  return cachedMidtoken;
}

export class QwenWebProvider {
  constructor(config, env) {
    this.id = config.id || "qwenweb";
    this.name = config.name || "Qwen Web (chat.qwen.ai)";
    this.type = "qwenweb";
    this.env = env;
    this.config = config.config || {};
    // 网页通道只走 SSE（与 workbuddy 同理，forceStream 让 dispatch 统一强制流式）
    this.forceStream = true;
    // 设备身份稳定复用（一台“设备”长期用，符合真机行为；默认自动指纹见 callChat）
    this.deviceId = this.config.deviceId || generateDeviceId();
  }

  get baseUrl() {
    const url = this.config.baseUrl || QWENWEB_DEFAULT_BASE_URL;
    return String(url).replace(/\/$/, "");
  }

  get account() {
    return {
      token: this.config.token || "",
      cookie: this.config.cookie || "",
      fingerprint: this.config.fingerprint || {}
    };
  }

  async callChat(payload, options = {}) {
    const fetchImpl = options.fetch || globalThis.fetch;
    // T3 决议：system 全留 + 最近 20 轮，中部静默丢弃（保前缀稳定）
    const split = splitHistory(payload?.messages);
    const { systemPrefix, turns } = truncateHistory(split.systemPrefix, split.turns);
    if (turns.length === 0) {
      return new Response(JSON.stringify({ error: { message: "No user/assistant turns to send" } }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }
    const model = payload?.model || "qwen3.7-plus";
    // 历史压单轮：system + 逐轮 role 标注，最新轮在尾（前缀稳定、可缓存）
    const squashed = [
      systemPrefix ? `System: ${systemPrefix}` : null,
      ...turns.slice(0, -1).map(t => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content}`),
      turns[turns.length - 1].content
    ].filter(Boolean).join("\n\n");
    const turn = buildTurn({ role: "user", content: squashed }, model, {});

    try {
      // 1) 建 chat 取 chat_id。指纹策略：账号存了浏览器抄录值则重放（最稳）；
      // 否则本地生成全套（antiBot.js，T6 锁定的指纹移植），umidtoken 抓不到就降级省略。
      const autoFp = this.config.autoFingerprint !== false;
      let headers;
      if (autoFp && !this.account.cookie) {
        const mid = await fetchMidtoken(fetchImpl).catch(() => null);
        headers = assembleRequestHeaders({
          deviceId: this.deviceId,
          token: this.account.token,
          umidtoken: mid || undefined
        }).headers;
      } else {
        headers = buildQwenHeaders({ fingerprint: { ...this.account.fingerprint, cookie: this.account.cookie } });
        if (this.account.token) headers["Authorization"] = `Bearer ${this.account.token}`;
      }
      const newChatRes = await fetchImpl(`${this.baseUrl}/api/v2/chats/new`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: options.signal
      });
      const newChatText = await newChatRes.text();
      if (!newChatRes.ok || isWAFBody(newChatText)) {
        return this.wafOrError(newChatRes.status, newChatText);
      }
      let chatId = null;
      try { chatId = parseChatNew(JSON.parse(newChatText)); } catch (e) {}
      if (!chatId) {
        return this.fail(502, `QwenWeb: cannot obtain chat_id: ${newChatText.slice(0, 120)}`);
      }

      // 2) 流式 completions，原样透传上游 SSE（归一在边读边转中完成）
      const body = buildCompletionsBody({ chatId, parentId: null, model, turn });
      const upstreamRes = await fetchImpl(
        `${this.baseUrl}/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`,
        { method: "POST", headers, body: JSON.stringify(body), signal: options.signal }
      );
      const ctype = upstreamRes.headers.get("content-type") || "";
      if (!upstreamRes.ok || (!ctype.includes("text/event-stream") && !ctype.includes("application/json"))) {
        const errText = await upstreamRes.text().catch(() => "");
        return this.wafOrError(upstreamRes.status, errText);
      }
      return new Response(this.toOpenAIStream(upstreamRes.body, model), {
        status: 200,
        headers: buildResponseHeaders(upstreamRes.headers, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Gateway-Account": this.id,
          "X-Gateway-Account-Id": this.id
        })
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return this.fail(502, `QwenWeb upstream transport failed: ${err?.message || err}`);
    }
  }

  // 错误收口：WAF/验证码特征 → 429（网关冷却漂移）；其他 → 透状态码
  wafOrError(status, text) {
    if (isWAFStatus(status) || isWAFBody(text)) {
      console.warn(`[QwenWeb] WAF/captcha challenge on provider "${this.id}", cooling down`);
      return this.fail(429, "QwenWeb anti-bot challenge (WAF/captcha): account cooling down, refresh fingerprint if persistent");
    }
    return this.fail(status || 502, text.slice(0, 300) || "QwenWeb upstream error");
  }

  fail(status, message) {
    return new Response(JSON.stringify({ error: { message } }), {
      status, headers: { "Content-Type": "application/json" }
    });
  }

  // qwen 自定义 SSE → OpenAI chat.completion.chunk SSE（下游现有转译器直接可用；
  // thinking 走 reasoning_content 键，与 opencode 通道约定一致）
  toOpenAIStream(upstreamBody, model) {
    return new ReadableStream({
      async start(controller) {
        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const created = Math.floor(Date.now() / 1000);
        const head = (delta, finish = null) => encoder.encode(`data: ${JSON.stringify({
          id: `qwen-${created}`, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta, finish_reason: finish }]
        })}\n\n`);
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === "[DONE]") continue;
              let obj = null;
              try { obj = JSON.parse(raw); } catch (e) { continue; }
              const ev = parseQwenSSEObject(obj);
              if (ev.kind === "reasoning" && ev.text) {
                controller.enqueue(head({ reasoning_content: ev.text }));
              } else if (ev.kind === "content" && ev.text) {
                controller.enqueue(head({ content: ev.text }));
              } else if (ev.kind === "done") {
                controller.enqueue(head({}, "stop"));
              }
              // notice/unknown/usage：静默跳过（usage 不透传，下游用量为网关估算）
            }
          }
        } catch (e) {
          controller.error(e);
          return;
        } finally {
          try { reader.releaseLock(); } catch (e2) {}
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
  }

  async getBalance() {
    return { success: false, balance: null, extra: "Qwen 网页版无余额接口（免费 Web 配额）" };
  }
}
