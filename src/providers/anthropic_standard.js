// Anthropic 原生上游 adapter —— 单账号直连，请求体按原生方言直通。
// 出站经 urlGuard 护栏；与 openai_standard 同构但保留 Anthropic 的 tools/system 形状。
import { assertPublicHttps, outboundFetchInit } from "./urlGuard.js";

export class AnthropicStandardProvider {
  constructor(config, env) {
    this.id = config.id;
    this.name = config.name || "Anthropic Compatible";
    this.type = "anthropic";
    // 推理方言：原生 Anthropic 上游走 thinking 块，不做 OpenAI 方言清洗（见 core/contract.js）。
    this.reasoningDialect = "anthropic";
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
    await assertPublicHttps(this.baseUrl, `${this.id} baseUrl`);
    const url = `${this.baseUrl}/v1/messages`;
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.config.anthropicVersion || "2023-06-01",
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    return await fetch(url, {
      ...outboundFetchInit(`${this.id} chat`),
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      signal: options.signal,
      keepalive: true
    });
  }

  async getBalance() {
    return { success: false, balance: null, extra: "Anthropic 官方无公共余额 API" };
  }
}
