# 0005 — 客户端可见错误信封收敛到 `src/http/redact.js`

- **Status**: Accepted
- **Date**: 2026-09-25
- **Touches**: `src/http/redact.js`, `src/exchange/dispatch.js`, `src/providers/workbuddy/index.js`, `src/core/failover.js`, `test/arch-c2-envelope.test.js`

## Context

三处各自拼装客户端错误回执，口径分叉：

- `dispatch.js:upstreamErrorResponse`：`{error:{message}}` + 脱敏（正确）。
- `workbuddy/index.js:mapResponse`：`accountResponse` body 为脱敏**纯文本**，
  却配 `Content-Type: application/json`——信封缺失。
- `failover.js` 兜底 502：`lastError.message` **原文直拼**（传输层细节泄漏），
  仅 `lastFail.text` 走脱敏。
- `dispatch.js:renderExhausted` 同样直拼 `lastError.message`。

## Decision

在 `redact.js`（failure-rendering seam，已有 `redactUpstreamText` 的唯一出口）
加信封构造器，所有三处经它出信封：

- `errorBody(message)`——可信文本直包 `{error:{message}}`，不脱敏。
- `upstreamErrorBody(rawText)`——上游原文在内部**恰好脱敏一次**后装信封；
  调用方传原文，禁止预脱敏（脱敏幂等，但单次调用让截断策略可审计）。
- `upstreamErrorResponse(status, rawText, extraHeaders?)`——dispatch 口径的
  CORS 预渲染响应；workbuddy 另需账号归因头，故只复用 body + 自有
  `accountResponse` 组装。
- `lastFailureDetail(lastError, lastFail)`——耗尽可变部分：按 driver 优先级
  取原文并脱敏一次；`lastError.message` 现与 `lastFail.text` 同口径，不再直拼。
- 截断策略 `UPSTREAM_ERR_MAX` 保持导出，在接口注释上可见。

刻意保留的差异：`dispatch renderExhausted` 的 `"<status> <text>"` 状态前缀
（历史格式；该分支仅无证据/纯异常时可达，单候选 fatal 仍走 `lastFail.response`）；
workbuddy 耗尽静态文案不变。统一的是**信封形状 + 脱敏恰一次**，不是文案逐字相同。

## Consequences

- workbuddy 失败 body 由纯文本变为 JSON 信封（此前 `Content-Type` 声称 JSON
  却不是 JSON，客户端 `res.json()` 在该路径 previously 会抛错）。
- `lastError.message` 的传输层细节不再原文回吐（行为修复，见 `test/arch-c2-envelope.test.js`）。
