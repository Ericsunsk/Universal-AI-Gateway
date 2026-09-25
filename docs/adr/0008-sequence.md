# 0008 — 11148 排序收归单一消息序列模块（C5）

- **Status**: Accepted
- **Date**: 2026-09-25
- **Touches**: `src/exchange/transform.js`, `test/arch-c5-sequence.test.js`

## Context

`src/exchange/transform.js` 里 tool-companion fan-out
（`pushToolResultMessages` 展开 companion tool 结果、
`pushTrailingImageMessage` 在 tool 之后补发图片 user 消息）与
`normalizeOpenAIMessages`（把 tool 结果重挂到 assistant tool_calls
正下方，满足上游 11148 序列规则）是三个平级 helper。

11148 恰恰坏在**它们之间的顺序上**：图片若插进
assistant tool_calls 与其 tool 结果之间，上游即报
`tool_call_sequence_broken`；而此前没有任何单个测试覆盖这种交错——
既有测试只分别断言 fan-out（图片剥离、tool 文本无 base64）与
re-sort（孤儿降级、缺失补齐、去重），中间地带是空白。

## Decision

引入唯一的排序主人 `OpenAIMessageSequence`（`src/exchange/transform.js`，
经门面 re-export），fan-out 与 re-sort 下沉为其内部事务：

- `appendToolExchange({ assistantMessage, toolResultBlocks, imageParts })` ——
  原子追加一次完整 tool 交换：assistant（含 tool_calls，可选）→ companion
  tool 结果（纯文本）→ 尾随图片 user 消息（若有，必在交换之末）。
  调用方不再分两次调用展开 + 补图，交错顺序在本方法内一次写死；
  两个原调用点（assistant tool_use 分支、tool_result 分支）各收敛为一次调用。
- `#pushToolResults` / `#pushTrailingImages` —— 原两个顶层 helper 原样内移
  为私有方法（`#`，与 `stream.js` 的 `StreamBlockState` 同风格），外部不可单独调用。
- `finalize()` —— 运行 11148 重挂并返回数组；`transformAnthropicToOpenAI`
  尾部由 `normalizeOpenAIMessages(openaiMessages)` 改为 `sequence.finalize()`。
- `sortToolSequence(messages)` —— 原 `normalizeOpenAIMessages` 本体逐行下沉；
  导出的 `normalizeOpenAIMessages` 保留为一层转发（`dispatch.js` OpenAI 直传
  路径与既有测试依赖它），保证游离调用与序列收尾走同一口径、逐字节一致。

刻意**不**改动的：`buildOpenAIContentParts` 的 `imageParts` 索引取用
（图文相对顺序）、无图片时 `content` 保持 string 的形状、
prune 全系、`normalize` 的孤儿降级 / 缺失补齐 / 去重语义。

## Consequences

**正向**
- 排序不变量只有一处定义、一个测试面（`test/arch-c5-sequence.test.js`，
  含 11148 校验子 `assertValid11148`）：同消息 companion 交错、
  跨消息 tool_result 带图、连续两段交换的图片归属、乱序输入的 finalize
  重挂，全部被单测锁定。
- 无图片负载输出逐字节不变（字节稳定性测试锁定）；图片负载保证 image last。

**代价 / 边界**
- 新增导出 `OpenAIMessageSequence`（append-only，不破坏既有导入）。
- 内部 helper 无向后兼容承诺：`pushToolResultMessages` /
  `pushTrailingImageMessage` 顶层函数已删除（逻辑在私有方法中逐行保留）。

## 验证

`npm test` 全绿（含新增 6 条 C5 用例与全部既有 exchange 用例）；
`npx oxlint` 在改动文件上 0 errors。关键用例：

- 同消息 tool_use + companion tool_result（含图）→ assistant/tool/user(image)，image last 且 tool 文本无 base64
- 跨消息 tool_result 带图 → 图片尾随其所属交换
- 连续两段交换 → 图片各归其段，无图片卡在 assistant 与其 tool 结果之间
- 无图片负载两次序列化逐字节相同；`finalize()` 与 `normalizeOpenAIMessages()` 同输入 deepEqual
- 图文交错 `[text, image, text, image]` 经 `imageParts` 索引保持原序
- 乱序裸输入（tool 先于 assistant 到达）→ 孤儿降级为 user，合法 11148

## Rollback

`git checkout -- src/exchange/transform.js` 并删除
`test/arch-c5-sequence.test.js` 与本文件即可；不涉及其他模块。
