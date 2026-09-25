# 0007 — Fleet 重建规则显式化为 FleetConfig 值对象

- **Status**: Accepted
- **Date**: 2026-09-25
- **Deciders**: (repo owner)
- **Touches**: `src/core/fleet.js`, `test/arch-c4-fleet.test.js`

## Context

`getProviderFleet(config, env)` 的复用规则是隐藏的：`providersFingerprint`
只比对 allowlist 字段（`id/type/enabled/region` + 账号 `id/enabled/userId`），
`config_version` 靠人工 bump（易忘），`env` 靠引用判等，余额短缓存另有 TTL 窗口。
凭据漂移（`baseUrl` / `apiKey` / `balanceUrl` / 账号 `accessToken`）不触发重建，
`ProviderFleet` 实例继续持有旧 `config` 引用 —— stale 凭据被藏在缓存后面。
下一次新增字段同样会漏进 allowlist，这是结构性问题，不是补两个字段能根治的。

## Decision

1. **`toFleetConfig(config, env)` 是唯一的 fleet 身份值**：`{ version, hash, env, ref }`，
   其中 `hash` 为 `providers` 全量快照 + `usage_provider_id` 的键序归一化 JSON
  （`sortCloneForFleet` 递归排序键名；语义相同、仅键序不同不重建；任意值漂移必重建）。
2. **`fleetConfigEquals(prev, next)` 是重建规则的唯一实现**：`env` 身份轮换必重建
   （避免 provider 持有旧 env/KV 绑定）；有版本号时比 `version + hash`
  （指纹兜底“只加 provider 不 bump”的场景）；无版本号时回退引用判等（与旧语义一致）。
3. **调用方签名不变**：`getProviderFleet(config, env)` 与 `ProviderFleet` 方法、
   `balanceCache` TTL 语义、KV 行为零改动；比较逻辑收在模块内部。
4. 有意保留 `fleet.js → providers/` 的 import 方向（已知 quirk，本次不碰）。

## Consequences

**正向**

- Stale 凭据类别被根除：任何 provider 字段漂移（含未来新增字段）都重建，不再维护 allowlist。
- `usage_provider_id` 漂移同样重建（旧指纹忽略它，`getBalance` 默认目标会 stale）。
- 键序归一化避免 KV 往返键序抖动导致的无谓重建。

**代价 / 已知边界**

- 无关展示字段（如 `name`）改动也会重建 —— 重建只是重建 provider 实例，方向是安全的
  （宁可多建，不可 stale）。
- `hash` 字符串驻留内存（含凭据明文快照），信任等级与 fleet 本体持有的 `config` 一致，
  永不记入日志；KV 直行写入仍建议 bump `config_version`。
- 无版本号配置仍走引用判等：每次传新对象即重建（旧语义，原样保留）。

## 验证

`npm test` 全绿（253 条，含新增 11 条；另有一次 15 条失败的偶发抖动，
随后连续三次全绿，失败项为计时敏感用例、与本改动无关）。
`npx oxlint src/core/fleet.js test/arch-c4-fleet.test.js` 0 errors。关键用例：

- `baseUrl` / `apiKey` / `balanceUrl` / WorkBuddy 账号 token 漂移 → 同版本仍重建
- `usage_provider_id` 漂移 → 重建；同内容异键序 → 复用
- 版本 bump / env 轮换 → 重建；无版本引用语义 → 保留
- `getBalance` 归一（无数值 `balance` → `success:false`）与短缓存命中语义不变

## Rollback

工作树未提交：`git checkout -- src/core/fleet.js` 并删除
`test/arch-c4-fleet.test.js` 与本文件即可。
