# 0009 — kernel 依赖纯度：`src/core/` 不得 import adapters（C6）

- **Status**: Accepted
- **Date**: 2026-09-28
- **Touches**: `src/providers/fleet.js`（自 `src/core/fleet.js` 迁入）, `test/arch-c6-kernel-purity.test.js`, `CONTEXT.md`

## Context

`CONTEXT.md` 的 `src/core/` 段落长期声称 shared kernel **no adapter imports**，
但该不变量从未被任何测试守护，也从未有 ADR 记录。结果是
`src/core/fleet.js` 越层存活了相当长的时间：

- `src/core/fleet.js:1` — `import { createProvider } from "../providers/index.js";`

它不只是 import，而是**整个文件的存在意义就是实例化 provider**
（`ProviderFleet` 4 段式快照重建 + `fleetConfigEquals` 的凭据漂移比较，205 行）。
它名义在 kernel、实质是 providers 的应用层编排器：`getProviderFleet` 全仓仅被
`src/index.js:7` 调用一次。它既是 kernel 的唯一例外，也是 `core/` 里唯一需要
`providers/` 才能跑测试的模块。

连带后果是一个**真实的模块环**：

```
src/core/fleet.js → src/providers/index.js → src/providers/workbuddy/index.js → src/core/failover.js
```

ESM 当前能容忍（`failover.js` 不回头 import `fleet.js`），但任何让
`failover.js` 反向引用 `fleet.js` 的重构都会炸成 `undefined` 导入。

同时 `src/core/failover.js` 依赖 `src/http/*`（`corsHeaders` / `errorBody` /
`lastFailureDetail` / `upstreamErrorBody`）。这一处**不是设计失误**：
`redact.js:3` 的注释说明，脱敏下沉到 `http/` 是为切断 `core ↔ exchange` 环，
是正确取舍。但它意味着「no adapter imports」这句话不足以描述 kernel 的真实依赖面——
kernel 允许依赖**叶子层**（`logging` / `http` / `kv` / `config`），只是没有写下来。

## Decision

1. **`fleet.js` 迁至 `src/providers/fleet.js`。** 它实例化 provider，就属于
   providers 层。迁移后 `src/core/` 的四个模块（`contract` / `scheduler` /
   `failover` / `tokenizer`）立即满足文档声称的不变量，`CONTEXT.md` 无需放宽措辞。
   相对路径随迁：`../providers/index.js` → `./index.js`，
   `./contract.js` → `../core/contract.js`。

2. **新增 `test/arch-c6-kernel-purity.test.js`，把不变量变成机器可验证的契约。**
   两条断言：
   - `src/core/*` 不得出现指向 `providers/` 或 `exchange/` 的 import；
   - `src/core/*` 的相对 import 只允许 `./`（core 内部）或叶子层
     `logging` / `http` / `kv` / `config`；裸模块（npm 包如 `gpt-tokenizer`）
     与 `node:` 内置放行。

3. **`CONTEXT.md` 的 core 段落补明依赖白名单**，使「no adapter imports」
   从一句口号变成可执行的边界描述；并注明该不变量由 C6 测试守护。

刻意**不**改动的：`failover.js` 对 `http/` 的依赖（见 Context，是切断
`core ↔ exchange` 环的正确取舍）；`providers → core` 方向
（`workbuddy` 复用 `runFailover` / `buildFail` 正是 ADR-0006 的意图）；
`runFailover` / `buildFail` 作为公共 kernel 原语的现状。

## Consequences

**正向**
- kernel 纯度从「文档声称」升级为「测试守护」——这正是此前让它失守的原因：
  不变量存在但无人验证。
- 消除了 `core ⇄ providers` 模块环，`fleet.js` 不再需要 `providers/` 才能测试。
- 新贡献者从 `CONTEXT.md` 能读到 kernel 的**真实**依赖面（含叶子层白名单），
  而不是一句会误导人的「no adapter imports」。

**代价 / 边界**
- `src/core/fleet.js` 路径变更（breaking for importers）。仓库内调用点仅
  `src/index.js:7` 与 3 个测试文件，已同步。
- C6 测试按**文件路径字符串**匹配，是启发式而非语义分析：它能抓住
  `import ... from "../providers/..."`，但不解析动态 `import()` 或
  重导出链。作为不变量护栏足够，不作为通用依赖分析器。

## 验证

- `npm test` 全绿（C6 两条断言 + 全部既有用例）。
- 变异测试确认护栏有效：向 `src/core/scheduler.js` 注入
  `import { createProvider } from "../providers/index.js";` 后
  C6 立即报 `src/core/scheduler.js → ../providers/index.js`。
- 迁移后 `grep -rn "core/fleet" src/ test/ api/` 无残留引用。

## Rollback

`git mv src/providers/fleet.js src/core/fleet.js`，还原上述两条相对路径，
并删除 `test/arch-c6-kernel-purity.test.js` 与本文件；不涉及其他模块。
