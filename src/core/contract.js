// Provider 契约 —— 把「一个 provider 适配器必须实现什么」从一个散落在 fleet.js
// 各处的鸭子类型探测，收敛为单一、有文档、可测试的定义。
//
// 契约（每个具体 provider 可实现的子集，未实现的视为「不支持该能力」）：
//   callChat(payload, options) -> Response        —— OpenAI 风格上游（必选，主路径）
//   callMessages(payload, options) -> Response    —— Anthropic 风格上游（anthropic 主路径）
//   getBalance() -> { success, balance, total, ...} —— 余额查询（可选）
//   doDailyCheckin() -> Promise<{...}>            —— 每日签到（可选）
//
// 能力探测统一收敛到这里的纯谓词，fleet.js / dispatch.js 不再手写 typeof 判断，
// 也不再 switch provider.type：调用方只探针，不认 tag。
// 注意：AnthropicStandardProvider 无 callChat（OpenAI 协议+Anthropic 上游由 dispatch
// 显式 400，见 dispatch.js）。“是否原生 Anthropic”以 hasCallMessages 为准。

export function hasGetBalance(provider) {
  return !!provider && typeof provider.getBalance === "function";
}

export function hasCallChat(provider) {
  return !!provider && typeof provider.callChat === "function";
}

export function hasCallMessages(provider) {
  return !!provider && typeof provider.callMessages === "function";
}

// 上游是否要求请求体强制 stream=true（如 WorkBuddy 非流式 JSON 可能是业务错误包）。
// 由 adapter 声明（forceStream === true），调用方只探针。
export function wantsStreamedChat(provider) {
  return !!provider && provider.forceStream === true;
}

// 推理方言取值：adapter 必须显式声明其一，不再从 provider.type 兜底推断。
// 新增上游须声明方言，避免「型名恰好叫 workbuddy 就继承 workbuddy 方言」这类隐式继承。
export const REASONING_DIALECTS = ["workbuddy", "openai", "anthropic"];

// 是否需要 WorkBuddy 方言清洗（拒收推理参数）。按 adapter 显式声明的 reasoningDialect 判定；
// 未声明即视为契约违约——报错而非静默兜底（兜底曾是 provider.type 字符串分支）。
export function needsReasoningScrub(provider) {
  if (!provider) return false;
  const dialect = provider.reasoningDialect;
  if (!REASONING_DIALECTS.includes(dialect)) {
    throw new Error(
      `Provider ${provider.type ?? provider.name ?? "<anonymous>"} 未声明 reasoningDialect；` +
      `须为 ${REASONING_DIALECTS.join(" | ")} 之一（见 core/contract.js）`
    );
  }
  return dialect === "workbuddy";
}

export function hasTokenRefresh(provider) {
  return !!provider && typeof provider.refreshAccessToken === "function";
}

export function hasDailyCheckin(provider) {
  return !!provider && typeof provider.doDailyCheckin === "function";
}
