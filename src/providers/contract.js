// Provider 契约 —— 把「一个 provider 适配器必须实现什么」从一个散落在 fleet.js
// 各处的鸭子类型探测，收敛为单一、有文档、可测试的定义。
//
// 契约（每个具体 provider 可实现的子集，未实现的视为「不支持该能力」）：
//   callChat(payload, options) -> Response        —— OpenAI 风格上游（必选，主路径）
//   callMessages(payload, options) -> Response    —— Anthropic 风格上游（anthropic 主路径）
//   getBalance() -> { success, balance, total, ...} —— 余额查询（可选）
//   onSchedule() -> Promise                        —— 定时保活（可选）
//   doDailyCheckin() -> Promise<{...}>            —— 每日签到（可选）
//
// 能力探测统一收敛到这里的纯谓词，fleet.js 不再手写 typeof 判断。
// 注意：callChat / callMessages 的调度由 provider.type 决定（见 exchange.js），
// 不通过能力探测，故这里只为 fleet.js 实际用到的三个可选能力提供谓词。

export function hasGetBalance(provider) {
  return !!provider && typeof provider.getBalance === "function";
}

export function hasOnSchedule(provider) {
  return !!provider && typeof provider.onSchedule === "function";
}

export function hasDailyCheckin(provider) {
  return !!provider && typeof provider.doDailyCheckin === "function";
}
