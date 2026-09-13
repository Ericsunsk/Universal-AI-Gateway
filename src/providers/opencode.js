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
