export class AnthropicStandardProvider {
  constructor(config, env) {
    this.id = config.id;
    this.name = config.name || "Anthropic Compatible";
    this.type = "anthropic";
    this.env = env;
    this.config = config.config || {};
  }

  get baseUrl() {
    let url = this.config.baseUrl || "https://api.anthropic.com";
    return url.replace(/\/$/, "");
  }

  get apiKey() {
    return this.config.apiKey || "";
  }

  // Anthropic 原生 messages
  async callMessages(payload, options = {}) {
    const url = `${this.baseUrl}/v1/messages`;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.config.anthropicVersion || "2023-06-01",
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    return await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      signal: options.signal,
      keepalive: true
    });
  }

  // 如果客户端发来 OpenAI 格式但上游是 Anthropic，可在这里调用或经由网关转换
  async callChat(payload) {
    return new Response(JSON.stringify({ error: { message: "Direct chat not supported on raw Anthropic provider" } }), { status: 400 });
  }

  async getBalance() {
    return { success: false, balance: null, extra: "Anthropic 官方无公共余额 API" };
  }

  async onSchedule() {}
}
