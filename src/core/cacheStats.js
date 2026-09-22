// 上游前缀缓存命中观测（进程级，只记日志不存内容）。
// 信号来源：OpenAI 形 usage.prompt_tokens_details.cached_tokens、
// Anthropic 形 usage.cache_read_input_tokens（见 stream.js extractCachedTokens）。
export function recordUpstreamCache(cachedTokens = 0) {
  const n = Number(cachedTokens) || 0;
  if (n > 0) {
    console.log(`[Cache] Upstream prefix-cache hit: ${n} cached tokens`);
  }
}
