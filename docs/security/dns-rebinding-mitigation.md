# DNS Rebinding 防护

## 问题描述

DNS rebinding 是一种 TOCTOU（Time-of-Check-Time-of-Use）攻击，利用 URL 验证与实际请求之间的时间窗口：

```javascript
// 1. 验证时 DNS 解析到公网 IP
await assertPublicHttps("https://evil.com/api");  // ✅ 通过验证

// 2. 攻击者修改 DNS，指向内网
// evil.com A 记录: 8.8.8.8 → 169.254.169.254

// 3. fetch 时重新解析 DNS，请求发往内网
await fetch("https://evil.com/api");  // ❌ 访问云 metadata 服务
```

## 防护方案

### DNS Pinning

在验证通过后，将域名替换为已验证的 IP 地址，避免后续 fetch 重新解析 DNS：

```javascript
import { assertPublicHttpsWithPinning } from "./providers/urlGuard.js";

// 1. 验证并获取 DNS-pinned URL
const { url, sni } = await assertPublicHttpsWithPinning(
  "https://api.example.com/v1/messages",
  "provider-id"
);

// 2. 使用 pinned URL 发送请求
const response = await fetch(url.toString(), {
  method: "POST",
  headers: {
    "Host": sni,  // 使用原始 hostname 作为 Host header
    "Content-Type": "application/json"
  }
});
```

### 工作原理

1. **DNS 解析与验证**
   ```javascript
   // 解析 api.example.com 得到 [1.2.3.4, 1.2.3.5]
   const addresses = await dns.lookup("api.example.com", { all: true });
   
   // 验证所有 IP 为公网地址
   if (addresses.some(({ address }) => isPrivateHostname(address))) {
     throw new Error("Domain resolves to private IP");
   }
   ```

2. **URL Pinning**
   ```javascript
   // 将 hostname 替换为第一个已验证的 IP
   const pinnedUrl = new URL("https://api.example.com/v1/messages");
   pinnedUrl.hostname = "1.2.3.4";
   // 结果: https://1.2.3.4/v1/messages
   ```

3. **SNI 保留**
   ```javascript
   // 返回原始 hostname 用于 TLS SNI
   return { url: pinnedUrl, sni: "api.example.com" };
   ```

### 为什么需要 SNI

TLS 握手需要原始域名用于：
- **SNI (Server Name Indication)**: 告诉服务器客户端要访问的域名
- **证书验证**: 验证服务器证书是否匹配原始域名

如果只使用 IP 地址：
```javascript
// ❌ 错误：TLS 握手失败
await fetch("https://1.2.3.4/api");
// Error: Hostname/IP does not match certificate's altnames

// ✅ 正确：保留 Host header 和 SNI
await fetch("https://1.2.3.4/api", {
  headers: { "Host": "api.example.com" }
});
```

## 使用指南

### Provider 集成

在 provider 构造函数中一次性验证并缓存 pinned URL：

```javascript
export class CustomProvider {
  constructor(config, env) {
    this.id = config.id;
    this.config = config.config || {};
    this.pinnedBaseUrl = null;  // 缓存 pinned 结果
  }

  async initialize() {
    // 启动时验证并 pin DNS
    const result = await assertPublicHttpsWithPinning(
      this.config.baseUrl,
      `${this.id} baseUrl`
    );
    this.pinnedBaseUrl = result;
  }

  async callChat(payload, options = {}) {
    if (!this.pinnedBaseUrl) {
      await this.initialize();
    }
    
    const url = `${this.pinnedBaseUrl.url.toString()}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
    
    // 如果有 SNI，添加 Host header
    if (this.pinnedBaseUrl.sni) {
      headers["Host"] = this.pinnedBaseUrl.sni;
    }
    
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal
    });
  }
}
```

### 性能优化

- ✅ **一次验证，多次使用** - 在构造函数中 pin DNS，避免每次请求都解析
- ✅ **缓存 TTL** - DNS 结果缓存 5 分钟（操作系统默认）
- ⚠️ **动态 IP** - 对于频繁变化的 CDN，可能需要定期重新 pin

### IP 字面量处理

如果 baseUrl 已经是 IP 地址，不需要 pinning：

```javascript
const result = await assertPublicHttpsWithPinning("https://8.8.8.8/api", "test");
// result.url.hostname === "8.8.8.8"
// result.sni === null  (无需 SNI)
```

## 测试覆盖

### 单元测试

```javascript
// test/audit-fixes.test.js

test("assertPublicHttpsWithPinning returns DNS-pinned URL for domains", async () => {
  const result = await assertPublicHttpsWithPinning(
    "https://api.anthropic.com/v1/messages",
    "test"
  );
  
  // pinned URL 的 hostname 是 IP
  assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(result.url.hostname));
  
  // SNI 是原始域名
  assert.equal(result.sni, "api.anthropic.com");
  
  // 路径保持不变
  assert.equal(result.url.pathname, "/v1/messages");
});

test("assertPublicHttpsWithPinning rejects domains resolving to private IPs", async () => {
  await assert.rejects(
    () => assertPublicHttpsWithPinning("https://localhost/test", "test"),
    /non-public/
  );
});
```

### 集成测试

验证实际 HTTPS 请求能够成功：

```javascript
const { url, sni } = await assertPublicHttpsWithPinning(
  "https://api.openai.com/v1/models",
  "integration-test"
);

const response = await fetch(url.toString(), {
  headers: sni ? { "Host": sni } : {}
});

assert.ok(response.ok, "Request with pinned URL should succeed");
```

## 安全边界

### ✅ 防护的攻击

1. **DNS rebinding** - 验证后修改 DNS 指向内网
2. **慢速 DNS 响应** - 延迟返回恶意 IP
3. **多 IP 域名** - 部分 IP 公网，部分内网（验证所有 IP）

### ⚠️ 不防护的攻击

1. **HTTP 重定向** - 通过 `redirect: "manual"` 在 `outboundFetchInit` 中防护
2. **HTTPS 证书欺骗** - 由 TLS 层防护
3. **初始 DNS 欺骗** - 假设第一次解析是可信的

## 相关文档

- [SSRF 防护](./ssrf-mitigation.md)
- [URL Guard 设计](./url-guard-design.md)
- [OWASP - DNS Rebinding](https://owasp.org/www-community/attacks/DNS_Rebinding)

## 修复历史

- **2024-09-28**: 添加 `assertPublicHttpsWithPinning` 函数 (P0-1)
- **2024-09-27**: 修复 SSRF 防护（RFC 6890 全量拦截）
