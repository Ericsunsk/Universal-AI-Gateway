export class OpenAIStandardProvider {
  constructor(config, env) {
    this.id = config.id;
    this.name = config.name || "OpenAI Compatible";
    this.type = "openai";
    this.env = env;
    this.config = config.config || {};
  }

  get baseUrl() {
    let url = this.config.baseUrl || "https://api.openai.com/v1";
    return url.replace(/\/$/, "");
  }

  get apiKey() {
    return this.config.apiKey || "";
  }

  async callChat(payload, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
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

  async getBalance() {
    // 部分兼容服务支持 /dashboard/billing/credit_grants 或类似接口
    if (this.config.balanceUrl) {
      try {
        const resp = await fetch(this.config.balanceUrl, {
          headers: { "Authorization": `Bearer ${this.apiKey}` }
        });
        const data = await resp.json();
        return { success: true, data };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, balance: null, extra: "暂不支持查询余额" };
  }

  async onSchedule() {
    // 标准服务默认无定时操作
  }
}
