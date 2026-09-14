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
import { headersFromParts, mintIdentity } from "./antiBot.js";
import { createGate, withGate } from "../../core/mutex.js";
import { createHash } from "node:crypto";

// 身份有效期：ssxmod/bx-ua 约 15 分钟，提前到 10 分钟轮换（宁早勿晚，避开过期窗口被风控加权）
const IDENTITY_TTL_MS = 10 * 60 * 1000;
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
    // 设备身份稳定复用（一台“设备”长期用，符合真机行为；默认自动指纹见 callChat）。
    // 无配置时按 provider id 确定性派生：重启不变、账号间不碰撞、无需持久化。
    this.deviceId = this.config.deviceId ||
      createHash("sha256").update(`qwenweb-device:${this.id}`, "utf8").digest("hex").slice(0, 20);
    // CF cron 刷新的身份缓存（内存 + KV 双层，跨 isolate 由 KV 兜底）
    this._identity = null;
    this._identityAt = 0;
    // 单并发门：同一账号同时只放 1 个在途上游调用，Claude Code 式 burst 在网关侧排队，
    // 不把并发行直接打给风控。客户端 abort 即摘除，不死锁。
    this._gate = createGate();
  }

  get kv() {
    return this.env?.GATEWAY_KV || this.env?.WORKBUDDY_KV || null;
  }

  identityKey() {
    return `QWEN_FP_${this.id}`;
  }

  // 取可用身份：内存 → KV → 现场 mint（mint 后写透 KV 供其他 isolate）。
  // 调用方（callChat 定时任务）只认“10 分钟内”的身份，过期即换。
  async ensureIdentity(fetchImpl) {
    const now = Date.now();
    if (this._identity && now - this._identityAt < IDENTITY_TTL_MS) return this._identity;
    const kv = this.kv;
    if (kv) {
      try {
        const raw = await kv.get(this.identityKey(), "json");
        const stored = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (stored && stored.cookie && stored.bxua && now - (stored.mintedAt || 0) < IDENTITY_TTL_MS) {
          this._identity = stored;
          this._identityAt = now;
          return stored;
        }
      } catch (e) {}
    }
    const minted = mintIdentity({ deviceId: this.deviceId });
    const identity = { ...minted, umidtoken: null };
    try {
      const mid = await fetchMidtoken(fetchImpl).catch(() => null);
      if (mid) identity.umidtoken = mid;
    } catch (e) {}
    this._identity = identity;
    this._identityAt = now;
    if (kv) {
      try { await kv.put(this.identityKey(), JSON.stringify(identity)); } catch (e) {}
    }
    return identity;
  }

  // 定时保活（fleet cron 调用）：身份过期才 mint，无 token 配置时直接跳过。
  // workbuddy 签到是每天；指纹 10 分钟一换由 TTL 门控，cron 频率变化不影响行为。
  async onSchedule() {
    if (!this.account.token) return { success: false, extra: "no token configured, skip" };
    const identity = await this.ensureIdentity(globalThis.fetch);
    return { success: true, mintedAt: identity.mintedAt };
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

    if (this._gate.queued > 0) {
      console.warn(`[QwenWeb] Account "${this.id}" busy, ${this._gate.queued} queued (serializing burst)`);
    }
    return withGate(this._gate, options.signal, async () => {
    try {
      // 1) 建 chat 取 chat_id。身份优先级：账号抄录重放（最稳）> cron/KV 身份 > 现场生成。
      // 现场生成走 ensureIdentity（自动写透 KV，下一次同 isolate 指纹一致）。
      const autoFp = this.config.autoFingerprint !== false;
      let headers;
      if (this.account.cookie) {
        headers = buildQwenHeaders({ fingerprint: { ...this.account.fingerprint, cookie: this.account.cookie } });
        if (this.account.token) headers["Authorization"] = `Bearer ${this.account.token}`;
      } else if (autoFp) {
        const identity = await this.ensureIdentity(fetchImpl);
        headers = headersFromParts({
          cookie: identity.cookie,
          bxua: identity.bxua,
          umidtoken: identity.umidtoken || undefined,
          token: this.account.token
        });
      } else {
        headers = buildQwenHeaders({ fingerprint: {} });
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
      if (!upstreamRes.ok || !ctype.includes("text/event-stream")) {
        // 非 SSE（含 application/json 业务错误包，如 FAIL_SYS_USER_VALIDATE）一律走错误收口，
        // 绝不把 JSON 当 SSE 空转成 200 空流（live 抓到的真实坑）。
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
    });
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
