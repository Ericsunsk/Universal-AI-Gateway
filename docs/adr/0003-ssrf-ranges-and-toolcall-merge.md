# 0003 — 收紧 SSRF 护栏地址分类 + 抽出 tool_call 分片合并纯函数

- **Status**: Accepted (Amended 2026-09-27: Modernized with `ipaddr.js`)
- **Date**: 2026-09-25
- **Touches**: `src/providers/urlGuard.js`, `src/exchange/stream.js`, `test/audit-fixes.test.js`, `test/exchange.test.js`

## Context

审计发现两处需要加固：

1. **`urlGuard` 的 IPv4 分类不完整**。原实现只拦 RFC1918 三段 + 回环 + 链路本地 + CGNAT，
   遗漏 RFC 6890 特殊用途地址中的其余不可全局路由区间（TEST-NET ×3、IETF 协议分配、
   6to4 中继任播、基准测试段、组播 `224/4`、保留 `240/4`、广播）。
   IPv6 侧用字符串前缀近似（`/^fc/`、`/^fe[89ab]/`）而非位判定。
2. **`stream.js` 两个函数圈复杂度 84 / 62**，其中 tool_call 分片合并逻辑**在两处重复**
   （流式 `sseToolFrags` 与非流式 `accumulatedToolCalls`），且无单测覆盖。

## Decision

### 1. `urlGuard` 段判定升级（采用成熟库 `ipaddr.js`）

- 原设计采用纯手写位判定以追求 0 依赖，但手写位操作及对各种 IPv4-mapped IPv6 变体的处理在实际演进中存在隐蔽缺陷与维护负担。
- **2026-09-27 架构升级**：引入行业标准库 `ipaddr.js`，统一规范化 IPv4/IPv6，利用成熟的 `range()` 分类精准拦截所有非 unicast 区间（RFC 6890 / RFC 4291），同时正确处理 IPv4-mapped IPv6 展开与已废弃的 RFC 3879 site-local。安全关键链路优先采信经数亿次验证的成熟算法。

### 2. `stream.js` 抽取 tool_call 合并纯函数

抽取可单测的纯函数，消除两处重复（2026-09-25 修订：未被生产调用的
`mergeToolCallDelta` 已删除，不保留向后兼容；唯一合并点为 `mergeSseToolFrags`）：

| 函数 | 职责 |
|---|---|
| `mergeSseToolFrags(frags, calls)` | 非流式落袋：按 `index` 定址合并，缺 id 用确定性占位 `__idx_${index}` |
| `toolCallsToAnthropicBlocks(acc)` | 累积列表 → Anthropic `tool_use` blocks（缺 id 补 `call_`，不产 `id:null`） |

定址必须用上游原始 `index`（`reduceOpenAIChunkAll` 已透出）：稀疏分片下每 chunk
只带一个 index，按 chunk 内序号 `ci` 查槽位会把 `index:1` 的碎片污染首槽位。
占位键按 `__idx_${index}` 确定性命名，跨 chunk 同 index 碎片直达同一槽位。

**同时修复一处既有缺陷**：`mergeSseToolFrags` 原实现的「占位键迁移」分支**不可达**。
原逻辑先按 `key = c.id || placeholder` 查表，但续片的 `c.id` 与占位键 `__idx_N` 永不相等，
故查表必然落空，走 `else` 新建槽位 —— 结果是**同一次工具调用占两个槽位**，
最终产出重复的 `tool_use` block（其中一个 id 还是随机生成、args 残缺）。

该场景可达：`reduceOpenAIChunkAll` 显式建模了 `id: tc.id || null`，即兼容上游首片不带 id。
修复方式：占位态用显式标志 `slot.ident = false` 记录，续片到达时**先按同序槽位定位再迁移**，
不依赖键名推断。

## Consequences

**正向**
- SSRF 护栏覆盖全部不可全局路由区间，且段边界经测试锁定（含所有相邻公网边界的反例）。
- tool_call 合并逻辑收敛为具名纯函数，补齐单测（含稀疏分片按 `index` 定址、并行调用、id 迟到、id 始终缺失）。
- 修复重复 `tool_use` block 缺陷与稀疏分片交叉污染。
- `StreamBlockState` 状态机抽出，流式读循环复杂度 **64 → 49**；`formatOpenAIToAnthropicJson` **84 → 64**。
  分派逻辑（`applyEmission`）与非流式转换收进状态机后，读循环只表达「解码 → 分派 → 写出」。
- `thinkingDelta` 计入 `emittedChars`，与非流式 `output_tokens` 口径一致（含 thinking）。

**代价 / 未竟**
- **`stream.js` 行数 652 → 750**（新增状态机与文档注释）。抽取降低的是单函数复杂度，未减总行数。
- **两处复杂度仍高于阈值（49 / 64）**。剩余分支来自 SSE 行缓冲解析（`indexOf("\\n\\n")` 循环、
  `[DONE]` 判定、坏行限流告警）与 usage 提取，属协议解析固有复杂度，需进一步拆循环。
- `urlGuard` 仍未防 DNS 形态（`*.nip.io`、内网 DNS 解析）—— 这是**设计边界**，
  彻底修复需在 fetch 层对已解析连接二次校验。

## 关于复杂度抽取的一处方法论教训

首次尝试只抽出「状态变量」（`currentBlockIndex` 等四个变量 → `StreamBlockState`），
**复杂度仍是 64，没有下降** —— 因为复杂的不是可变状态，而是 `emission.kind === "..."` 的
if/else-if 长链。第二次把**分派本身**移入状态机（`applyEmission`）才降到 49。

结论：降低圈复杂度要针对**分支所在的表达式**下手，而非其操作的状态。

## 验证

`npm test` 全绿（234 条）。关键用例：

- RFC 6890 全 16 个 IPv4 区间被拦；IPv6 按位判定（含 `fec0::1` 不误杀——已弃用 site-local 不在 `fe80::/10` 内）
- 段边界精确性：`172.15.255.255`/`172.32.0.0`、`100.63.255.255`/`100.128.0.0` 等 24 个相邻公网边界全部放行
- `mergeSseToolFrags` 五种分片时序：首片带 id / 首片无 id 续片补 id / 并行混合 / 始终无 id / 稀疏分片按 index 定址
- `reduceOpenAIChunkAll` 透出 `index`；`toolCallsToAnthropicBlocks` 缺 id 补 `call_`
- `StreamBlockState`：block 切换先 stop 后 start、类型不匹配的 delta 被抑制、`setStopReason` 不降级、
  `close` 幂等、未知 emission kind 安全忽略

另做端到端流验证（构造含 thinking + text + tool_call 分片 + usage 的完整 SSE）：

- block 序列 `0:thinking → 1:text → 2:tool_use`，索引连续、每块正确闭合
- tool_use 的 `id`/`name` 保留（`call_a`/`search`），`input_json_delta` 正确拼接
- `stop_reason: "tool_use"`、usage 透传、`message_stop` 存在
- 空流合成 1 个空 text 块闭环；纯 args 碎片先到时 block index 为 0（非非法的 -1）


## Rollback

`git revert` 本次提交。
