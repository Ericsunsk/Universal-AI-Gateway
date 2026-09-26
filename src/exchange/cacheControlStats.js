// cache_control 断点观测（进程级，只计数不存内容）。
//
// 决策背景：Anthropic 客户端（尤其 Claude Code）会在 system prompt 与长工具结果上打
// cache_control: {type:"ephemeral"}。本网关当前把它当未知字段丢弃，从不主动打缓存断点，
// 意味着长 system prompt 的多轮会话每次全量重算 prefill —— 与「首字求快（TTFT）」的北极星冲突。
//
// 本模块**只做测量**，不改变任何请求行为：产出「带断点的请求占比」与「断点打在哪一层」，
// 用来决定是否值得做断点透传。若结论为否，可连同调用点一并移除。
//
// 计数为进程级累加，随实例生命周期归零（与 cacheStats 同口径）；
// 生产默认静默，DEBUG=true 时逐条打点，便于用一段真实流量采样。
import { log } from "../logging/logger.js";

const stats = {
  totalRequests: 0,          // 观测到的 Anthropic 入站请求总数
  requestsWithBreakpoints: 0, // 其中至少带一个 cache_control 的请求数
  breakpoints: 0,            // 断点总数（一个请求可打多个）
  byLayer: {
    system: 0,               // system 字段（string 或 text block）
    tools: 0,                // tools 定义
    messages: 0,             // messages 内普通 content block
    tool_result: 0           // tool_result 块或其内部 content
  }
};

// 判断一个对象是否是 cache_control 断点标记。
function isBreakpoint(x) {
  return !!(x && typeof x === "object" && x.cache_control && typeof x.cache_control === "object");
}

/**
 * 观测一次 Anthropic 入站请求的 cache_control 使用情况。
 * 纯计数 + 可选日志，无返回值，绝不抛错 —— 观测路径不得影响主链路。
 *
 * @param {object} body - Anthropic Messages 请求体（已解析）
 */
export function recordCacheControl(body) {
  try {
    stats.totalRequests += 1;
    if (!body || typeof body !== "object") return;

    let found = 0;

    // 层 1：system —— 可能是 string（不可能带断点）或 block 数组
    if (Array.isArray(body.system)) {
      for (const b of body.system) {
        if (isBreakpoint(b)) { found += 1; stats.byLayer.system += 1; }
      }
    }

    // 层 2：tools 定义 —— 断点通常打在整个 tools 数组的最后一项上
    if (Array.isArray(body.tools)) {
      for (const t of body.tools) {
        if (isBreakpoint(t)) { found += 1; stats.byLayer.tools += 1; }
      }
    }

    // 层 3：messages 与 tool_result —— content block 级
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!m || !Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (!b) continue;
          if (b.type === "tool_result") {
            if (isBreakpoint(b)) { found += 1; stats.byLayer.tool_result += 1; }
            // tool_result 的 content 自身也可以是 block 数组
            if (Array.isArray(b.content)) {
              for (const inner of b.content) {
                if (isBreakpoint(inner)) { found += 1; stats.byLayer.tool_result += 1; }
              }
            }
          } else {
            if (isBreakpoint(b)) { found += 1; stats.byLayer.messages += 1; }
          }
        }
      }
    }

    if (found > 0) {
      stats.requestsWithBreakpoints += 1;
      stats.breakpoints += found;
      if (process.env.DEBUG === "true") {
        log.debug("cache_control breakpoints observed", { count: found, layers: stats.byLayer });
      }
    }
  } catch {
    // 观测永不阻断主链路
  }
}

/**
 * 读取当前累计快照（比例由调用方计算，避免除零口径分歧）。
 * @returns {{totalRequests:number, requestsWithBreakpoints:number, breakpoints:number, byLayer:object, rate:number}}
 */
export function getCacheControlStats() {
  return {
    totalRequests: stats.totalRequests,
    requestsWithBreakpoints: stats.requestsWithBreakpoints,
    breakpoints: stats.breakpoints,
    byLayer: { ...stats.byLayer },
    // 带断点请求占比；无样本时为 0（不产出 NaN）
    rate: stats.totalRequests > 0 ? stats.requestsWithBreakpoints / stats.totalRequests : 0
  };
}

// 测试用重置：避免用例间相互污染。
export function resetCacheControlStats() {
  stats.totalRequests = 0;
  stats.requestsWithBreakpoints = 0;
  stats.breakpoints = 0;
  stats.byLayer = { system: 0, tools: 0, messages: 0, tool_result: 0 };
}
