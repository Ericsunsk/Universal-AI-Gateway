// 上游前缀缓存命中观测（进程级，只记日志不存内容）。
import { log } from "../logging/logger.js";
// 信号来源：OpenAI 形 usage.prompt_tokens_details.cached_tokens、
// Anthropic 形 usage.cache_read_input_tokens（见 stream.js extractCachedTokens）。
// 输出受 logger 级别门控（DEBUG=1/true/* 或 LOG_LEVEL=debug 均生效）——
// 此处不再自行判断 DEBUG：logger 已在发射时解析级别，重复判断不仅冗余，
// 还会因只认字面量 "true" 而漏掉 "1"/"*"，把本该输出的 debug 静默吞掉。
export function recordUpstreamCache(cachedTokens = 0) {
  const n = Number(cachedTokens) || 0;
  if (n > 0) {
    log.debug("Upstream prefix-cache hit", { cached_tokens: n });
  }
}
