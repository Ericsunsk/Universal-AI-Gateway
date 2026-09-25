# 0004 — 收敛 SSE 行源：两处读循环合一为 `iterSseParsedChunks`

- **Status**: Accepted
- **Date**: 2026-09-25
- **Touches**: `src/exchange/stream.js`, `test/arch-c1-linesource.test.js`
- **Continues**: ADR-0003（流式读循环复杂度 49、非流式 64 中剩余的行缓冲解析分支）

## Context

ADR-0003 把分派（`StreamBlockState.applyEmission`）与合并（`mergeSseToolFrags`）
抽出后，两处读循环仍各写一遍相同的行缓冲解析：`reader.read()` →
`TextDecoder` 流式解码 → 按 `\n` 切行 → `data:` 过滤 → `[DONE]` 跳过 →
`JSON.parse` → 坏行限流告警（`badLineWarns < 3`）。这是纯粹的重复，
不是两处各有的领域逻辑。

## Decision

新增共享行源 `iterSseParsedChunks(reader, options)`（async generator，
`yield { parsed, rawLine }`），拥有以下行为：

- 读循环 + 流式解码 + 行缓冲切分 + `data:` 过滤 + `[DONE]` 跳过 +
  `JSON.parse` + 坏行限流告警（cap 保持 3）。
- 告警文案经 `options.warnMessage` 保留两处原措辞（流式 `"Skipping
  malformed SSE line"` / 非流式 `"... (non-streaming)"`）。
- 未成行尾巴经 `options.tail = { text }` 出口透出（两处单 JSON 回退语义不同，
  回退本身仍归消费方）。
- 字节到达钩子 `options.onBytes` 供流式停滞熔断更新 `lastUpstreamByteAt`；
  abort / stall 接线仍归 `streamOpenAIToAnthropic`。

刻意**不**上收的（仍归消费方）：`extractUsage` /
`extractCachedTokens` 记账、`reduceOpenAIChunkAll` 归约、`applyEmission` /
`mergeSseToolFrags` 发射处理、尾巴单 JSON 回退。两处 token 变量与落袋语义
不同，上收只会制造参数对象，不减少分支。

Deletion test：删掉本模块，循环原样搬回两处 —— 它 earned its keep，
自立为 parsed-chunk 接缝。

## Consequences

**正向**

- 行缓冲解析 single-source：`[DONE]` / 坏行 cap / 切行语义改一处即两处生效。
- 两处消费函数只剩「记账 → 归约 → 发射」，读循环杂质清零。

**行为澄清（一处，非回归）**

- 原实现把 `JSON.parse` **连同发射/写出**包在同一 `try` 内：下游写出失败
  （如下游中途断开）会被误记为一条 "Skipping malformed SSE line" 告警后吞掉。
  重构后解析失败仍走限流告警（语义不变），发射/写出异常则直达既有的外层
  stream 错误路径（`[Gateway Warning: Upstream stream interrupted]` 闭环）。
  公开 SSE 事件序列、JSON 形状、token 记账（含 thinking）、stall 与 abort
  接线保持不变，`npm test` 全绿为证（含 abort / stall / usage / tool 落袋用例）。

## 验证

`npm test` 全绿（242 条：原 234 + 新增 8）。新增
`test/arch-c1-linesource.test.js` 锁定：行源基本语义（noise / `[DONE]`）、
逐字节分片重组、`tail` 出口、坏行告警 cap=3 与两处文案、默认 decoder、
`onBytes` 钩子、分片投喂下流式事件序列 + usage、非流式 tool 落袋。

`npx oxlint` 0 errors（warnings 均为文件既有 `catch (e)` 惯用法）。

## Rollback

`git revert` 本次提交（未提交，需手动 `git checkout --` 三文件）。
