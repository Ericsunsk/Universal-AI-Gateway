// Failover —— 全网关唯一的“逐项尝试 + 分类切换”循环。
// account scheduler 提炼了分类词汇（cooldown / retry / fatal），但 workbuddy 的账号循环与
// dispatch 的候选循环各自重写了一遍“classify → 切换 / 返回”。本模块收敛这个循环：
// 调用方只描述“试一次”（attempt）与“可重试时的副作用”（onRetryable），不再手写循环。
//
// attempt(item, index) 约定：
//   - `{ done: Response }` —— 拿到可用响应（含调用方自定的成功渲染），直接返回。
//   - `{ fail: { status, text, json?, response? } }` —— 失败；由 classify 定去留。
//       fatal → 返回调用方预渲染的 fail.response；cooldown/retry → onRetryable 后试下一项。
//       response 必须预渲染（fatal 与耗尽时直接返回，不再二次拼装）。
//   - 返回 null/undefined —— 跳过该项（如账号缺 token），不记失败。
//   - 抛错 —— 传输失败：记录后试下一项；isAbort(err) 为 true 则直接抛出终止。
// 耗尽：返回最后一个 fail.response；没有则调 renderExhausted({ lastError, lastFail })。
import { classify } from "./scheduler.js";
import { corsHeaders } from "../http/headers.js";

export async function runFailover(items, { attempt, onRetryable, isAbort, renderExhausted }) {
  let lastError = null;
  let lastFail = null;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let outcome;
    try {
      outcome = await attempt(item, index);
    } catch (err) {
      if (isAbort?.(err)) throw err;
      lastError = err;
      continue;
    }
    if (outcome?.done) return outcome.done;
    const fail = outcome?.fail;
    if (!fail) continue;
    lastFail = fail;
    const action = classify(fail.status, fail.text, fail.json ?? null);
    if (action === "fatal") return fail.response;
    if (onRetryable) await onRetryable(item, action, fail);
  }

  if (lastFail?.response) return lastFail.response;
  if (renderExhausted) return renderExhausted({ lastError, lastFail });
  return new Response(JSON.stringify({
    error: { message: `All candidates failed. Last error: ${lastError?.message || lastFail?.text || "none"}` }
  }), {
    status: 502,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
