// 测试共享脚手架 —— 只收敛**纯机械**的重复部分。
//
// 设计取舍：各测试里的 provider stub 看似相似，实则每处都嵌着不同的行为
// （不同状态码/响应体、是否捕获 sentPayload、是否参与 failover）。把那些
// 合并成一个「万能 stub」会把每个用例的意图藏进参数里，反而更难读。
// 故本模块只提供两类真正无差别的构造：
//   1. SSE 帧字面量 —— 手写 JSON 字符串极易打错且与协议细节无关；
//   2. 最小 fleet 桩 —— 只要实现 dispatch/failover 真正调用的那三个方法。
//
// 各用例仍自行定义 provider 的 callChat 行为，保持意图显式。

/**
 * 构造一个 OpenAI SSE data 帧（含空行分隔）。
 * @param {string} text 增量正文
 * @param {{finish?: string, extraDelta?: object}} [opts] finish_reason 与额外 delta 字段
 */
export function sseDelta(text, { finish, extraDelta } = {}) {
  const delta = { content: text, ...(extraDelta || {}) };
  const choice = finish ? { delta, finish_reason: finish } : { delta };
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

/** SSE 流结束哨兵帧。 */
export const SSE_DONE = "data: [DONE]\n\n";

/** 把若干 SSE 帧拼成完整流（自动补 [DONE]）。 */
export function sseStream(...chunks) {
  return chunks.join("") + SSE_DONE;
}

/** 构造一个 SSE 上游 Response。 */
export function sseResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" }
  });
}

/** 构造一个 JSON 上游 Response。 */
export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * 最小 fleet 桩：只实现 dispatch / failover 真正调用的接口。
 *
 * providers 形如 { id: { callChat, ... } }；返回的实例自动补上 id 字段，
 * 因为 dispatch 的兜底链会读 getAllActive()[0].id 再回查 getProvider(id)。
 */
export function makeFleet(providers) {
  const map = new Map();
  for (const [id, p] of Object.entries(providers)) {
    map.set(id, p.id ? p : { id, ...p });
  }
  return {
    getProvider: (id) => map.get(id) || null,
    getAllActive: () => [...map.values()],
    activeCount: map.size
  };
}
