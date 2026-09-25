# 0006 — fail 构造收归 failover driver（`buildFail` seam）

- **Status**: Accepted
- **Date**: 2026-09-25
- **Touches**: `src/core/failover.js`, `src/exchange/dispatch.js`, `src/providers/workbuddy/index.js`, `test/arch-c3-fail.test.js`

## Context

`dispatch.js` 与 `workbuddy/index.js` 各自手拼
`fail = { status, text, json, response, force }`，真实 bug 藏于此处：
fatal 缺 `response`（driver 直接返回 `undefined` 到 HTTP 层）、陈旧 `text`、
传输抖动的 `fail: null` 分支。outcome 词汇（done/skip/switch/retry）与
retryBudget/signal/force 语义必须保持不变。

## Decision

接缝划在「原始证据」与「fail 对象」之间，构造权归 driver：

- `buildFail(evidence, render?)`（`failover.js` 导出，唯一构造者）：
  取 `status/text/json?/force?/headers?`，`response = render(fail) ?? C2 兜底信封`，
  fatal 永不缺 `response`。`headers` 为渲染 hint（直通，`classifyFailure` 忽略）；
  `render` hint 本身不进入 canonical fail。
- `runFailover` 新增 `renderFail(fail, item, index)` 选项（调用方声明渲染口径，
  追加的可选字段）：dispatch 传 CORS 信封口径（含 provider 归因日志），
  workbuddy 传账号归因口径。`ensureFail` 按“单次 `fail.render` hint >
  driver 级 `renderFail` > C2 兜底”补齐无 `response` 的证据；
  自带 `response` 的旧 fail 原样保留（`failover.test.js` 兼容）。
- `outcome.evidence` 可作为 `fail` 的别名（同为原始证据）。
- attempt 侧：dispatch 只交 `{ status, text, force? }`，不再预渲染；
  workbuddy 经 `failForAccount`（原始证据 + hint）调用 driver 拥有的
  `buildFail`——直接调用 `attemptAccount` 的单测仍可见 `fail.response`，
  且语义与 driver 内补齐的完全一致（构造器同一出处）。

## Consequences

- 分类输入仍是原始 `status/text/json`（`classifyFailure` 行为零变化；
  5xx→retry、429→cooldown、fatal 直返的判定与上报动作保持不变）。
- `fail: null`（传输错误）分支语义不变：仍记通用 `lastError`，不借用陈旧 `lastFail`。
- `onRetryable(item, action, fail)` 拿到的 fail 现恒带 `response`（此前证据-only
  路径可能缺失）。
