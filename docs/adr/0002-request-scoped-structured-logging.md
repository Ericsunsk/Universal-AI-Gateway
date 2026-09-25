# 0002 — 请求作用域结构化日志（AsyncLocalStorage 全量接入）

- **Status**: Accepted
- **Date**: 2026-09-25
- **Touches**: `src/logging/logger.js`, `src/index.js`, `api/index.js`, `server.js`, 全量 `console.*` 收敛点

## Context

`src/logging/logger.js` 具备完整的结构化日志能力（`createLogger` / `logRequest` /
`logResponse` / `generateTraceId` / `extractTraceId` / `sanitize` 脱敏），并有 8 个单元测试。
但审计发现：**该模块在生产代码中被引用次数为 0** —— 唯一 import 方是它自己的测试文件。
实际日志走 45 处散落的 `console.*`，无 trace_id、无脱敏、无级别控制。

`docs/SHORT_TERM_IMPROVEMENTS.md` 却将其标记为「✅ 完成」，属文档与实现不符。

接入时遇到的结构性障碍：这 45 处调用分布在 `providers/workbuddy`、`core/failover`、
`core/cacheStats`、`kv` 等深层，这些函数（如 `recordUpstreamCache(cachedTokens)`、
`setAccountCooldown(account, env, action)`）均不接收 logger，也没有上下文传递机制。
若把 logger 作为参数逐层穿透，将为一件事由污染十余个工具函数的签名。

## Decision

**引入 `AsyncLocalStorage` 承载请求作用域，日志在任意深度直接调用，不改动任何既有函数签名。**

1. `logger.js` 新增：
   - `runWithLogger(context, fn)` —— 建立作用域，内部 `log.*` 自动携带 `trace_id`。
   - `currentLogger()` —— 取当前作用域日志器；不在作用域内回落 root logger（不抛错）。
   - `log` —— 深度无关入口；`createLogger` 内部同样脱敏，直持实例调用不再绕过。
2. `src/index.js` 的 `fetch` 入口用 `runWithLogger` 包裹处理链，
   `trace_id` 经 `extractTraceId(request) || generateTraceId()` 生成（`extractTraceId`
   缺头返回 `null`，不自行生成，职责单一）。
3. 45 处 `console.*` 全部替换为 `log.*`，插值为结构化字段而非字符串拼接。
4. `logger.js` 新增 `setLogSink(fn)`：日志唯一写出通道可注入，
   测试用收集器观察日志，不再 monkey-patch `console`。
5. `sanitize` 键名归一化（去 `_-`、小写）并追加 `credential`、精确 `key`：
   `api_key`/`x-api-key`/`apiKey` 统一命中，`monkey` 不误杀。
6. 删除从未被调用的 `logRequest`/`logResponse`（死代码，不保留向后兼容）。

## 顺带修复的两个既有缺陷

- **日志级别在创建时固化**：`createLogger` 原先在构造时读取 `LOG_LEVEL`。
  root logger 于模块加载建立，导致此后设置 `DEBUG`/`LOG_LEVEL` 永久失效。
  改为发射时解析级别。
- **子进程 stdout 污染**：`test/config.test.js` 以 `JSON.parse(execFileSync(stdout))` 读结果，
  而 config 模块的结构化日志写入 stdout，导致 JSON 解析失败。经 `setLogSink` 将子进程日志
  改道 stderr 解决。

## Consequences

**正向**
- 全链路 `trace_id` 关联；`providers`/`core`/`kv` 的工具函数签名保持不变。
- 所有日志字段经 `sanitize` 脱敏（含归一化 `apikey`/`credential`/精确 `key`；`createLogger`
  内部同样脱敏，直调用例不再绕过）。
- 日志通道可注入，测试不再依赖全局猴子补丁。

**代价 / 边界**
- 依赖 `node:async_hooks`，**不适用于 Vercel Edge Runtime**。当前部署为 Node
  （`server.js` 用 `node:http`，`api/index.js` 用 `node:stream`），故不构成限制；
  若未来迁移 Edge，需改回显式 logger 注入。
- `AsyncLocalStorage` 有极小的每请求开销（实测可忽略）。
- `recordUpstreamCache` 等原先被 `try{}catch{}` 包裹的调用点，现若日志抛错会被静默吞掉 ——
  已确认 sink 默认实现不抛错。

## 已知未处理（登记，不阻塞）

`src/exchange/stream.js` 两个函数圈复杂度远超阈值（oxlint 阈值 20）：

| 函数 | 复杂度 |
|---|---|
| `formatOpenAIToAnthropicJson` | 84 |
| `formatOpenAIToAnthropicStream` | 62 |

这是协议转换的固有复杂度（SSE 解析 + tool_call 分片拼接 + thinking 累积 + token 计数 +
finish_reason 归一化集中在一个函数），**非编码错误**。`stream.js` 亦为全项目最长文件。目前只登记，不重构。

## 后续进展（2026-09-25 同日）

已做部分抽取（见 ADR 0003）：`mergeSseToolFrags` / `mergeToolCallDelta` /
`toolCallsToAnthropicBlocks` 三个纯函数从 `stream.js` 抽出并补齐单测，`formatOpenAIToAnthropicJson`
复杂度 84 → 64。**流式闭包仍为 64** —— 其复杂度源于 SSE 解析与 emission 分派在同一 async 循环内交织，
需结构性改动而非抽取辅助函数，故留待后续。

## 验证

`npm test` 全绿（234 条）。另做端到端手工验证：

- `trace_id` 经两层 async 纵深自动贯穿（`runWithLogger` → `midLayer` → `deepProvider`）。
- 无作用域时回落 root logger，不抛错。
- 脱敏生效：`Bearer sk-secret123` → `Bear****`。
- `x-trace-id` 请求头被正确提取，缺失时生成新 id。

## Rollback

`git revert` 本次提交。改动集中在 `logger.js` 与 45 处调用点的机械替换。
