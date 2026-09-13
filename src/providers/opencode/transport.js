// 代理传输 —— 代理列表解析与跨环境 fetch 分发（Node undici / Workers 改写）。
export function parseProxyList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
  return String(raw)
    .split(/[,;\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 跨环境的代理请求分发器 (Node.js/Vercel/Cloudflare Workers)
 */
export async function executeFetchWithProxy(url, fetchInit, proxyUrl) {
  if (!proxyUrl) {
    return fetch(url, fetchInit);
  }

  // Node.js / Vercel: 动态载入 ProxyAgent（使用变量规避 esbuild 静态解析打包）
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      const modName = "undici";
      const { ProxyAgent } = await import(/* @vite-ignore */ modName);
      return await fetch(url, {
        ...fetchInit,
        dispatcher: new ProxyAgent(proxyUrl)
      });
    } catch (e) {
      console.warn(`[OpenCode Proxy] Failed to use undici ProxyAgent with ${proxyUrl}:`, e.message);
    }
  }

  // Cloudflare Workers 或通用转发端点: 支持带 ?url= 或代理改写
  if (proxyUrl.includes("://")) {
    try {
      if (proxyUrl.includes("?url=") || proxyUrl.endsWith("?url")) {
        const fullUrl = proxyUrl.includes("=") ? `${proxyUrl}${encodeURIComponent(url)}` : `${proxyUrl}=${encodeURIComponent(url)}`;
        return await fetch(fullUrl, {
          ...fetchInit,
          headers: {
            ...fetchInit.headers,
            "X-Target-URL": url
          }
        });
      }
    } catch (e) {}
  }

  return fetch(url, fetchInit);
}
