// OpenAI 兼容上游 adapter —— 单账号直连，无账号池/轮转。
// 出站经 urlGuard 护栏（https + 公网校验 + redirect:manual）；故障转移由 exchange/failover 驱动。
import { assertPublicHttps, outboundFetchInit } from "./urlGuard.js";

export class OpenAIStandardProvider {
  constructor(config, env) {
    this.id = config.id;
    this.name = config.name || "OpenAI Compatible";
    this.type = "openai";
    // 推理方言：标准 OpenAI 上游接受 reasoning_effort，无需清洗（见 core/contract.js）。
    this.reasoningDialect = "openai";
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
    await assertPublicHttps(this.baseUrl, `${this.id} baseUrl`);
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
      "Connection": "keep-alive",
      ...(this.config.defaultHeaders || {})
    };

    return await fetch(url, {
      ...outboundFetchInit(`${this.id} chat`, { signal: options.signal }),
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      keepalive: true
    });
  }

  async getBalance() {
    // 部分兼容服务支持 /dashboard/billing/credit_grants 或类似接口
    if (this.config.balanceUrl) {
      try {
        await assertPublicHttps(this.config.balanceUrl, `${this.id} balanceUrl`);
        const resp = await fetch(this.config.balanceUrl, {
          ...outboundFetchInit(`${this.id} balanceUrl`),
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
}
