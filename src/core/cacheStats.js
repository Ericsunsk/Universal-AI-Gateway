// 上游前缀缓存命中观测（进程级，只记日志不存内容）。
// 信号来源：OpenAI 形 usage.prompt_tokens_details.cached_tokens、
// Anthropic 形 usage.cache_read_input_tokens（见 stream.js extractCachedTokens）。
// 生产环境已禁用日志（避免每次请求都打印），如需调试可启用 DEBUG=true。
export function recordUpstreamCache(cachedTokens = 0) {
  const n = Number(cachedTokens) || 0;
  if (n > 0 && process.env.DEBUG === "true") {
    console.log(`[Cache] Upstream prefix-cache hit: ${n} cached tokens`);
  }
}
