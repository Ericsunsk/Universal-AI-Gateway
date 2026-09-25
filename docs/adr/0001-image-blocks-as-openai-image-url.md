# 0001 — 图片块映射为 OpenAI `image_url`，不再一律拒绝

- **Status**: Accepted
- **Date**: 2026-09-25
- **Deciders**: (repo owner)
- **Touches**: `src/exchange/transform.js`, `src/exchange/dispatch.js`, `test/exchange.test.js`

## Context

Anthropic 协议的 `image` 内容块此前在转译为 OpenAI 方言时被一律 400 拒绝，多模态输入无法经本网关透传。

转译路径上有两个约束决定了实现形态：

1. **OpenAI `tool` 消息的 content 只能是文本。** `tool_result` 内若含图片，整体 `JSON.stringify` 会把数 MB base64 灌进 tool 文本，既污染模型输入也炸掉 token 预算。
2. **OpenAI 要求 `tool` 消息紧跟带 `tool_calls` 的 assistant 消息。** 图片 part 不能插在这条序列中间，否则上游报错（如业务码 11148）。

同时，网关的信任边界要求：上游响应体不可信，但客户端需要能归因自己的错误。

## Decision

1. **`imageBlockToImagePart` 是唯一映射点**，其余位置不再各写一份。
   - `source.type:"base64"` → `data:<media_type>;base64,<data>`；`media_type` 按 Anthropic 规范必填，缺失不猜、直接 400。
   - `source.type:"url"` → 原样透传。
   - 非法 source（缺 `source` / 未知 `type` / 缺 `data` 或 `url`）→ 抛 `err.status = 400`，走 `dispatch` 的 short-circuit，不进故障转移。

2. **`tool_result` 内的图片抽出，以紧随其后的 `user` 消息补发**（`pushTrailingImageMessage`），tool 消息本身只留文本。

3. **`pruneMessageContents` 逐块清洗**：含图片的 `tool_result` 中，文本块照常 optimize，图片块原样保留，避免整体 stringify 把图片降级为 JSON 垃圾。（2026-09-25 修复：内层 `innerModified` 未同步外层 `modified`，导致含图分支 prune 整体失效，旧 huge 全量上游；已修复并经 `5000L` 对照验证 `5015→460 collapsed`。）

4. **`assistant` 消息携带 image 块 → 400**（`assertNoAssistantImages`）。Anthropic 协议不允许 assistant 发图，OpenAI 方言也放不下；静默丢弃会让客户端以为图已送达。

5. **上游错误回吐前脱敏**（`src/http/redact.js:redactUpstreamText`，4xx/5xx 同口径）：上游响应体可能含内部端点、账号标识、配额信息，一律替换为 `<url>` / `<credential>` / `<ip>` 并截断至 300 字符；日志同样只记脱敏后文本。5xx 此前裸传 `errText`（单候选时 driver 直接返回 `fail.response`），与 `renderExhausted` 的原文拼接一并收敛。本模块自身的参数校验文案是可信的，不过此处。另：凭据模式追加 `token` 通配（`invalid token abc...` 同样脱敏）。

## Consequences

**正向**
- 多模态输入可透传；不含图片的请求输出逐字节不变（零回归）。
- 上游拒收图片时客户端收到 400 而非 502 —— 4xx（非 402/403/429）无业务码时 `classifyFailure` 判 fatal，返回预渲染响应而不进退避。
- 图片不进 token 预算，也不破坏 tool_calls 序列。

**代价 / 已知边界**
- `source.type:"url"` 指向内网地址构成 SSRF 面。本仓库不 fetch 该 URL（由上游取），故不套用 `providers/urlGuard.js` —— 该护栏只守项目的 `baseUrl`/`balanceUrl`。此为显式取舍，非疏漏。
- 8 MB 请求体上限（`src/index.js:10`）限制超大图片；现状可容纳绝大多数 base64 图片。
- `toolResultBlockText` 在 OpenAI 方言路径中对未知对象 `JSON.stringify` 的既有行为未改动 —— 该函数被 `normalizeOpenAIMessages` 与门面测试共用，且 OpenAI 方言内不存在 Anthropic image 块。
- 脱敏实现已从 `dispatch.js` 内联移至 `src/http/redact.js`（`failover`/`workbuddy` 共用，避免 core↔exchange 循环依赖）。

## 验证

`npm test` 全绿（234 条）。关键用例：

- base64 / url 映射与顺序保持
- 非法 source → 400
- `tool_result` 图片剥离，tool 文本不含 base64
- 上游拒收图片 → 客户端 400（非 502）
- 上游 4xx 文本中的端点 / 凭据 / 内网 IP 不回吐
- `assistant` 消息携带 image → 400

## Rollback

`git revert` 本次提交即可；改动集中在 `src/exchange/transform.js` 与 `src/exchange/dispatch.js`。
