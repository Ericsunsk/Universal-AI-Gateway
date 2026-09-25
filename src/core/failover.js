// Failover —— 全网关唯一的「逐项尝试 + outcome 解释」驱动器。
//
// 回顾（commit 2032a3e）：曾经 workbuddy 的账号循环与 dispatch 的候选循环各自重写了一遍
// 「classify → 切换 / 返回」。本模块收敛这个循环，但第一版只收敛了骨架——真正的复杂度
// （何时原地重试、何时跳过、401 刷新）仍散落在各 adapter 的回调里。
//
// 本版把接缝重新划在「一次网络往返」与「一次决策」之间：
//   - **attempt** 只做一次网络往返，把结果映射为恰好一个 **outcome**（无 sleep、无内层循环）。
//   - **driver**（本模块）拥有重试预算、延迟、abort 检查与 classify，是唯一解释 outcome 的地方。
//
// attempt(item, index) 返回的 outcome（闭合四元组，见 CONTEXT.md）：
//   - `{ kind: "done", response }` —— 拿到可用响应，直接返回。
//   - `{ kind: "skip", reason? }` —— 从未真正尝试（如账号缺 token）；不计失败、不惩罚、不重试。
//   - `{ kind: "switch", fail }` —— 把原始证据交给 driver 的 classify 定去留。
//       fatal → 返回 driver 构造的 fail.response；cooldown/retry → onRetryable 后试下一项。
//       fail 即原始证据 `{ status, text, json? }`（+ 可选 force / headers / render hint），
//       response 由 driver 经 buildFail 统一预渲染（fatal 与耗尽时直接返回，不再二次拼装）。
//       兼容：自带 response 的旧 fail 原样保留（直接返回，不重建）。
//       fail.force === "retry" —— 调用方断言“这次失败是当前项特有的”（如模型身份错误，
//       后面有不同模型的候选），即使 classify 判 fatal 也切换；上报时不惩罚，只切换。
//       fail.headers —— 渲染 hint（如上游响应头），classify 忽略，只供 renderFail 组装响应。
//       fail.render —— 可选的单次渲染 hint (fail, item, index) => Response，优先于 driver 级 renderFail。
//       outcome.evidence 可作为 fail 的别名（同为原始证据）。
//   - `{ kind: "retry", fail, delayMs? }` —— 瞬时抖动（5xx / 传输错误），请求 driver 原地
//       重试同一项。driver 依据 retryBudget 决定是否批准：批准则等待 delayMs 后再次 attempt
//       同一项；预算耗尽则把这个 fail 升级为一条 switch 记录（照常 classify，response 同样由
//       driver 补齐）。fail 为空（传输错误）时记为传输失败的 lastError，不借用陈旧 lastFail。
//       adapter 只“请求”重试，预算与 abort 由 driver 掌握。
//
// driver 选项 renderFail(fail, item, index) => Response —— 调用方声明“失败渲染口径”
// （dispatch 的 CORS 信封 / workbuddy 的账号归因），attempt 不再手写 response。
// 未声明且 fail 无预渲染时，driver 以 C2 信封兜底，保证 fatal 永不返回 undefined。
//
// 兼容：调用方若直接抛错（未包装成 outcome），driver 视为一次传输失败并切换到下一项
// （isAbort(err) 为 true 时直接抛出终止）——这是 retry 的一种退化形态。
//
// 耗尽：返回最后一个 fail.response；若最后发生的是未包装异常则返回该异常；都没有则调
// renderExhausted({ lastError, lastFail })。
import { classifyFailure } from "./scheduler.js";
import { corsHeaders } from "../http/headers.js";
import { errorBody, lastFailureDetail, upstreamErrorBody } from "../http/redact.js";
import { log } from "../logging/logger.js";

// fail 构造的唯一拥有者：attempt 只交原始证据，预渲染 response 归这里。
// render(fail) 为调用方声明的渲染口径；缺省时以 C2 信封兜底（fatal 永不缺 response）。
// headers 为渲染 hint（直通，不参与 classify）；render hint 本身不进入 canonical fail。
export function buildFail(evidence = {}, render = null) {
  const fail = { status: evidence.status, text: evidence.text };
  if (evidence.json !== undefined) fail.json = evidence.json;
  if (evidence.force !== undefined) fail.force = evidence.force;
  if (evidence.headers !== undefined) fail.headers = evidence.headers;
  const response = typeof render === "function" ? render(fail) : null;
  fail.response = response || defaultFailResponse(fail);
  return fail;
}

function defaultFailResponse(fail) {
  const status = Number.isFinite(fail?.status) ? fail.status : 502;
  return new Response(upstreamErrorBody(String(fail?.text ?? "none")), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// 无 response 的原始证据经调用方口径（单次 hint 优先，其次 driver 级 renderFail，
// 都没有则 C2 兜底）补齐为 canonical fail；已有 response 的旧 fail 原样保留。
function ensureFail(raw, item, index, renderFail) {
  if (raw.response) return raw;
  const hint = typeof raw.render === "function" ? raw.render : null;
  const render = hint
    ? (f) => hint(f, item, index)
    : (renderFail ? (f) => renderFail(f, item, index) : null);
  return buildFail(raw, render);
}

export async function runFailover(items, {
  attempt,
  onRetryable,
  isAbort,
  renderExhausted,
  // 失败渲染口径 (fail, item, index) => Response：attempt 只交原始证据时由 driver 补齐 response。
  renderFail = null,
  // 每个 item 允许的原地重试次数上限（retry 预算）。0 = 完全不原地重试。
  retryBudget = 1,
  // retry outcome 未显式给 delayMs 时的默认等待。
  retryDelayMs = 0,
  // 可选：等待重试期间响应的 AbortSignal。
  signal = null
}) {
  let lastError = null;
  let lastFail = null;
  // 最近一次失败的类型：记录到达顺序，让耗尽收尾能用“最后发生的那次”作为权威错误。
  let lastFailureKind = null; // "error" | "fail"

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let retriesLeft = retryBudget;

    // 同一项的原地重试内层循环：仅由 outcome.kind === "retry" 驱动，且受预算约束。
    while (true) {
      let outcome;
      try {
        outcome = await attempt(item, index);
      } catch (err) {
        if (isAbort?.(err)) throw err;
        // 未包装异常 = 一次传输失败：若有预算，请求原地重试；否则作为权威错误记下并切换。
        if (retriesLeft > 0) {
          retriesLeft--;
          await waitOrAbort(retryDelayMs, signal);
          continue;
        }
        lastError = err;
        lastFailureKind = "error";
        break;
      }

      if (outcome?.kind === "done") {
        // 防御：done 缺 response 是 adapter bug——退化为 skip（而非返回 undefined 到 HTTP 层），并告警。
        if (!outcome.response) {
          log.warn("Item returned done without a response; treating as skip", { index });
          break;
        }
        return outcome.response;
      }
      if (outcome?.kind === "skip") break; // 跳过：不计失败、不重试
      if (outcome?.kind === "retry") {
        if (retriesLeft > 0) {
          retriesLeft--;
          await waitOrAbort(outcome.delayMs ?? retryDelayMs, signal);
          continue;
        }
        // 预算耗尽：把这次瞬时失败升级为 switch 记录。fail 为空（传输错误）时
        // 记为传输失败的 lastError，不借用陈旧 lastFail 做 classify。
        const rawRetry = outcome.fail ?? outcome.evidence;
        if (rawRetry) {
          const fail = ensureFail(rawRetry, item, index, renderFail);
          lastFail = fail;
          lastFailureKind = "fail";
          const action = classifyFailure(fail);
          if (action === "fatal" && fail.force !== "retry") return fail.response;
          if (onRetryable) await onRetryable(item, action === "fatal" ? "retry" : action, fail);
        } else {
          lastError = lastError || new Error("Upstream transport failed after retry budget exhausted");
          lastFailureKind = "error";
          if (onRetryable) await onRetryable(item, "retry", { status: 0, text: lastError.message });
        }
        break;
      }
      if (outcome?.kind === "switch") {
        const raw = outcome.fail ?? outcome.evidence;
        if (!raw) break;
        const fail = ensureFail(raw, item, index, renderFail);
        lastFail = fail;
        lastFailureKind = "fail";
        const action = classifyFailure(fail);
        if (action === "fatal" && fail.force !== "retry") return fail.response;
        if (onRetryable) await onRetryable(item, action === "fatal" ? "retry" : action, fail);
        break;
      }
      // 未知/畸形 outcome：视为跳过，避免误判为失败；非空畸形必须告警，
      // 否则 adapter 拼错字段会静默丢失候选（null/undefined 视为历史遗留的 skip 写法，保持静默）。
      if (outcome !== null && outcome !== undefined) {
        log.warn("Item returned malformed outcome; treating as skip", { index, outcome: JSON.stringify(outcome)?.slice(0, 200) });
      }
      break;
    }
  }

  // 耗尽收尾：以“最后发生的那次失败”为权威。
  // 优先级：真实的最后失败响应 > 调用方自定义 renderExhausted > 兜底 502。
  // 最后一项是未包装异常（网络/传输失败）时，不能返回更早 fail 的预渲染响应，否则真实异常被掩盖。
  const lastIsError = lastFailureKind === "error" && !!lastError;
  if (lastFail?.response && !lastIsError) return lastFail.response;
  if (renderExhausted) return renderExhausted({ lastError, lastFail });
  // C2：兜底 502 经同一 JSON 信封；可变部分恰好脱敏一次（见 lastFailureDetail）。
  return new Response(errorBody(`All candidates failed. Last error: ${lastFailureDetail(lastError, lastFail)}`), {
    status: 502,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}

// 等待 ms 毫秒；若 driver 收到 signal 且已 abort（或等待期间 abort），则抛出 AbortError（与 fetch 一致）。
function waitOrAbort(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!ms || ms <= 0) return Promise.resolve();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
