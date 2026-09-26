# 优化诊断报告：云端 → agent 客户端链路

> **状态**：诊断完成，未动任何代码。等你 review 后再决定执行。
> **日期**：2026-09-25
> **范围**：`gateway.ericstudio.pp.ua` 线上部署的「云端 → agent 客户端」链路
> **北极星**（你的决策）：**分层**——首字求快（TTFT），长流求稳（不断连）

---

## 0. 结论先行

**一句话**：你的链路**没有坏**，探针 7/7 断言通过；但**固定开销约 1 秒、TTFT 约 2 秒**，而这份开销的大头**不在你的代码里**，在 **Cloudflare → Render 这一跳**。所以本次优化的真正杠杆不是「修 bug」，而是**减少每一跳的固定成本**。

**三条最重要的发现**：

| # | 发现 | 影响 |
|---|---|---|
| 1 | **链路比你以为的多一跳**：`客户端 → Cloudflare → Render`（响应头 `server: cloudflare` + `x-render-origin-server: Render`） | Cloudflare 是 SSE 的第一道中间层，也是 TTFT 的第一笔固定成本 |
| 2 | **TTFB 实测 2.0~2.6s**，其中 `/healthz`（零业务逻辑）就占 **1.0~1.5s** | 约 1 秒是平台固定开销，与你的业务无关 |
| 3 | **心跳机制是正确的，我此前的怀疑是错的**（见 §1.2） | `stream.js:438` 有心跳发射 + stall 熔断二合一，实现优于预期 |

**我不建议现在做任何重构。** 理由见 §4——你的北极星（首字快）的瓶颈在平台层，不在代码层，而重构 `transform.js` 的收益无法验证。

---

## 1. 线上实测数据（报告第 (a) 节）

**方法**：`scripts/probe-agent.mjs` 打真实部署（`https://gateway.ericstudio.pp.ua`），模型 `deepseek-v4.1-flash`，协议 Anthropic。另有 `curl` 直测 `/healthz`。

### 1.1 业务链路实测

| 场景 | HTTP | TTFB | 总耗时 | usage | 断言 |
|---|---|---|---|---|---|
| 流式 `tool_use` | 200 | **2047ms** | **2194ms** | input=281 / output=38 | **7/7 PASS** |
| `thinking` block | 200 | **2637ms** | — | input=17 / output=115 | SKIP（上游不支持） |
| 前缀缓存 | 200 | — | — | input=4037（两次完全一致） | SKIP（上游无 cache 字段） |

**读法（关键）**：场景 1 的 **TTFB(2047ms) ≈ 总耗时(2194ms)**，而答案只有 **38 个 output token**。这说明：**2 秒几乎全是"等待"，不是"生成"**。生成 38 token 用时约 150ms，其余 2 秒是固定开销。**这是「首字快」北极星的直接靶子。**

**协议正确性**：7/7 通过 —— tool_use 有 id/name、arguments 是合法 JSON、`stop_reason=tool_use` 正确、`input_json_delta` 增量正常。**你的协议转译层是健康的。**

### 1.2 心跳与 stall 熔断（重要更正）

**我在探索阶段怀疑「`KEEP_ALIVE_BYTES` 定义了但没发射」，这个怀疑已被证伪。** 实际实现（`src/exchange/stream.js:435-468`）：

```js
let pingInterval = setInterval(async () => {
  if (!stalled && Date.now() - lastUpstreamByteAt > stallMs) {
    stalled = true;
    log.warn("Upstream stalled, closing stream", {...});
    clearInterval(pingInterval);
    try { upstreamReader?.cancel(new Error("Upstream stalled")); } catch (e) {}
    return;                          // ← 熔断：取消上游，让读循环正常收尾
  }
  try { await writer.write(KEEP_ALIVE_BYTES); } catch (e) {}
}, 4000);
```

**这段代码做对了两件事**，值得明确肯定：
1. **心跳与 stall 熔断合并为一个定时器**，间隔 **4000ms**，无条件发 ping（除熔断那一 tick）。
2. **熔断时 `cancel` 上游 reader 而非 `abort` writer** —— 注释写明：「不 abort writer，否则下游收不到 `message_stop`。客户端看到空内容而非无限挂起」。**这正是避免"静默截断"的正确做法**：客户端会收到完整的 `message_stop` 闭环，而不是被掐断。

**但有一个粒度细节**：stall 判定由 **4 秒 tick** 驱动，所以 180s 的 stall 实际在 **180~184s** 触发。这是可接受的，但**它意味着"首字节超时"若要精确，不能复用心跳 tick，得独立计时**（见 §3）。

**为什么 dump 里看不到 ping**：测试请求仅持续 3 秒，短于 4000ms 的 ping 间隔。**没有 ping 是正常的。**

### 1.3 平台与固定开销

```
$ curl -I https://gateway.ericstudio.pp.ua/healthz
server: cloudflare
x-render-origin-server: Render
cf-cache-status: DYNAMIC
cf-ray: a40af59fbbf0aebe-LAX
```

**链路真实拓扑（这是本次诊断最值钱的一条）：**

```
agent 客户端 (Claude Code)
   ↓ HTTPS
Cloudflare 边缘 (LAX)          ← 第一跳：TLS 终止 + 可能的 SSE 缓冲
   ↓ 回源
Render (free tier, 抗休眠探针)
   ↓ fetch
workbuddy 上游 (腾讯云) → deepseek-v4.1-flash
```

`/healthz` 连续三次直测（零业务逻辑端点）：

| # | DNS | TLS | TTFB |
|---|---|---|---|
| 1 | 2ms | 441ms | **1547ms** |
| 2 | 2ms | 329ms | **1377ms** |
| 3 | 3ms | 356ms | **1036ms** |

**其中 TLS 0.33~0.44s 是 Cloudflare 边缘握手**（正常，可接受）；但 **TTFB 1.0~1.5s、扣除 TLS 后仍有 0.6~1.1s** —— 对一个只回 `{"status":"ok","time":"..."}` 的端点，**这 0.6~1.1s 就是"Cloudflare 回源 Render + Render 冷态唤醒 + 你的进程启动开销"的合计**。

**推论**：业务请求的 2 秒 ≈ **平台固定开销 0.6~1.1s** + **上游首字节 0.9~1.4s**。两者各占一半。**你的代码在其中的占比很小。**

---

## 2. 代码级隐患清单（报告第 (b) 节）

按「影响 × 触发概率」排序。**注意：由于实测显示链路健康，下表多数是"理论隐患"而非"正在流血"。**

### H1 — 单函数承载全部路由，健康检查也会拉起完整进程 ⚠️ 中

- **位置**：`vercel.json` 历史的 rewrite + `src/index.js:42` `/healthz`
- **现状**：所有路径由一个 handler 处理。`/healthz` 设计上刻意最小化（不暴露 version/provider/model，防指纹），但它**仍是同一个进程**，探测它 = 唤醒整个服务。
- **影响**：你的抗休眠探针**如果打 `/healthz`**，唤醒的是"空壳进程"；但实测显示业务请求仍有 2s 延迟，说明**唤醒是有效的**（否则会看到 30~60s 冷启动）。所以这条**风险低于预期**。
- **触发条件**：无（当前工作正常）
- **修复代价**：低
- **风险**：低

### H2 — `Retry-After` 与 60/min 限流对 agent 场景偏低 ⚠️ 中

- **位置**：`src/ratelimit/ratelimit.js:84-89`，`standard: { capacity: 60, refillRate: 60/60 }` = **60 req/min**
- **影响**：agent 场景每轮工具调用 = 1 次请求。Claude Code 密集调试时**可能逼近 60/min**
- **实测**：本次探针未触发 429，**说明当前用量远低于阈值**
- **触发条件**：多轮工具调用密集进行时
- **修复代价**：极低（改一个常量，或按 `principal` 分级）
- **风险**：极低
- **备注**：你是**单账号单用户**，60/min 大概率够用。**建议观察而非立即改**。

### H3 — `dispatch.js` 候选层 `retryBudget: 0`，单账号下等于"不重试" ⚠️ 中（未来相关）

- **位置**：`src/exchange/dispatch.js:95-97`（候选层不重试，注释说明"切换候选比重发更快"）、`src/core/failover.js:84`（`retryBudget = 1`）
- **影响**：**单账号下没有"候选"可切**，所以 `retryBudget: 0` 意味着**上游抖动 = 直接失败**，一次重试都没有
- **你已明确**：后面会加多账号 → 这套机制是**待激活产能，不是过度设计**
- **触发条件**：上游瞬时抖动
- **修复代价**：低（加账号时一并调）
- **风险**：低
- **建议**：**加账号时再动**。现在改反而会掩盖问题。

### H4 — KV 超时在旧 Node 上静默降级为"无超时" ⚠️ 低

- **位置**：`src/kv/index.js:43-44`（`AbortSignal.timeout` 不存在时返回 undefined）
- **影响**：KV 在**鉴权关键路径**上（`src/index.js:153-154`），卡死会挂住整个请求
- **触发条件**：只在你换到 Node < 18 时。**Render 默认 Node 版本 ≥ 18，所以当前不触发**
- **修复代价**：低
- **风险**：低

### H5 — 无 metrics / 无告警 / trace_id 只进 stdout ⚠️ 中（但见 §4）

- **位置**：`src/logging/logger.js`（ALS + trace_id → stdout）；无 `/metrics`、无 `/ready`
- **影响**：stall、超时、上游错误率**无法告警**，只能事后翻 Render 日志（免费层日志保留有限）
- **修复代价**：中
- **风险**：低（纯新增）

### H6 — 无自定义连接池 / keep-alive ⚠️ 低（但见 §1.3）

- **位置**：全部 5 处上游调用用全局 `fetch`（undici 默认 agent）
- **影响**：理论上每次请求重建连接、TLS 握手计入 TTFT
- **但我必须诚实**：**§1.3 的实测显示，TTFB 的大头是 Cloudflare 回源，不是 undici 连接池**。而且 Render 常驻进程下 undici **本身就会复用连接**（与 Vercel serverless 不同）。**这条的收益可能接近于零。**
- **建议**：**不做**。除非有数据证明连接建立占显著比例。

### 已证伪 / 已排除

| 我曾怀疑 | 实测结论 |
|---|---|
| 心跳没发射 | ❌ **错**。`stream.js:438` 有发射，间隔 4s |
| stall 180s vs 平台 300s 硬杀 | ❌ **不适用**（你已离开 Vercel；Render 无此硬上限） |
| SSE 被压缩缓冲 | ❌ 未观测到（Node 适配器主动 `no-transform`，`api/index.js:165`） |
| 代理破坏流式 | ❌ 7/7 断言通过，协议完整 |

---

## 3. 优化方案（报告第 (c) 节）

**前提**：北极星是分层的——**首字快 / 长流稳**。据此，两段式超时是核心方案。

### 方案 A：两段式超时（首字节 + stall）★ 推荐

**理念**：「上游**从未响应**」和「上游**响应了但中途卡住**」是**两种不同故障**，当前用同一个 180s 处理，是概念混淆。

| 阶段 | 现在 | 建议 | 行为 |
|---|---|---|---|
| **上游首字节** | 无独立超时（共用 180s） | **新增 ~30s** | 30s 无首字节 → 干净返回错误（**为未来多账号预留"换号"扩展点**） |
| **首字节后 stall** | 180s（由 4s tick 驱动） | 维持 180s | 中途卡住 → 180s 后发 `message_stop` 闭环 |

- **改动位置**：`src/exchange/dispatch.js`（首字节超时，在进入 `streamOpenAIToAnthropic` 之前）+ `src/exchange/stream.js:123`（常量）
- **测试影响**：`test/exchange.test.js` **无 stall 路径测试**（已确认），需新增
- **风险**：低-中（需确保超时路径仍发 `message_stop`）
- **收益**：**把"上游从未响应"从干等 180s 变成 30s 明确失败**——直接服务「首字快」

### 方案 B：限流分级 ⚠️ 建议观察

- `standard` 60/min → 单用户下够用。**除非实测到 429，否则不改。**

### 方案 C：Cloudflare 层优化 ⚠️ 待验证（本次最大未知）

**这是本次诊断发现的新战线**，但**我无法从代码验证**，需要你确认：

- **Cloudflare 是否对 `/v1/messages` 做了缓冲？** 需检查 Cloudflare 的 `Cache Rules` / `Speed → Optimization`（尤其 **"Rocket Loader"、"Auto Minify"、以及是否开了 "Cache Everything"**——后者会破坏 SSE）
- **Cloudflare 空闲超时**：CF 对**无数据的流式响应**有约 **100 秒**的空闲断连。你的心跳 4s 一次**足以喂饱它**，所以理论上安全——**但值得实测验证**
- **收益**：如果 CF 有缓冲/优化干扰，关掉它**可能直接省掉几百毫秒**

### 方案 D：不做连接池（见 H6）

**明确建议放弃**，理由见 H6。

---

## 4. `transform.js` 重构的前置条件（报告第 (d) 节）

**你授权了重构，但我的建议是：现在不要做。** 理由链：

1. **ADR-0008 自承测试空白**：`transform.js` 的 "tool-companion fan-out 与 re-sort 的**交错地带**"是测试空白——既有测试只分别断言 fan-out 和 re-sort，**中间地带没有覆盖**。
2. **实测显示这块代码工作正常**：7/7 断言通过，tool_use 转译正确。
3. **你的北极星（首字快）的瓶颈在平台层（§1.3），不在 `transform.js`**。重构**无法改善 TTFT**。
4. **风险不对称**：重构收益 = 可维护性（抽象）；风险 = 在测试盲区改动**高频路径**。

**如果仍要做，前置条件是**（按顺序）：
- (d-1) 先补 ADR-0008 的**交错地带测试**（独立任务，本身有独立价值）
- (d-2) 补 §3 方案 A 的 stall 路径测试
- (d-3) 有可观测性兜底（§5），确保重构后能发现回归
- (d-4) 单次提交只做一件事（你 HEAD 的 `e868da2` 一次干了 5 件事，不建议延续）

---

## 5. 可观测性方案（报告第 (f) 节）

按你排序的**第一优先**。建议**最小集**，避免过度工程：

| 项 | 内容 | 位置 |
|---|---|---|
| `/ready` | 与 `/healthz` 分离：`/healthz` 保活（轻）、`/ready` 就绪（校验 fleet + 上游可达） | `src/index.js` 新增 |
| **TTFT 埋点** | 记录「收到客户端请求 → 写出首个 SSE 事件」的毫秒数，带 trace_id | `stream.js` |
| **上游首字节埋点** | 记录「发出上游请求 → 收到上游首字节」 | `dispatch.js` |
| **stall 计数** | `stalled = true` 时已有 `log.warn`（`stream.js:443`）→ 提升为**独立计数器**，可聚合 | `stream.js` |
| **聚合输出** | 无需引入 Prometheus；在 `/status` 加一个只读 JSON 段（计数器快照）即可 | `src/index.js:56` |

**不做**：Prometheus / OTel / Sentry（单用户场景过度）。

---

## 6. 探针记录（报告第 (e) 节）

**你的决策**：探针"稳定，不用管"。**记录如下，我未做任何改动**：

| 项 | 状态 |
|---|---|
| 打哪个 URL | **未核实**（你说稳定，我未探测） |
| 频率 | **未核实** |
| 谁在打 | **未核实** |
| 鉴权 | **未核实** |
| 是否真正防住休眠 | **间接证据**：本次实测业务请求 TTFB 2s（非 30~60s 冷启动），**说明探针有效** |

**唯一的建议**（不改，仅提示）：若探针打的是 `/healthz`，它刻意不加载 fleet（防指纹设计）。业务请求仍快，说明唤醒足够。**无需改动。**

---

## 7. 安全提示（附带）

⚠️ **本次诊断中，你的生产 key 已出现在对话记录里**，而 Claude Code 的 session 落盘到 `~/.claude/projects/`。

你的 `CHANGELOG.md` 2.5.1 记录过 **H1：`.env.local` 泄露真实凭证**。**建议**：轮换这个 key，并在需要再次实测时改用「你自己跑 + 贴输出」的方式。

---

## 8. 建议的执行顺序

严格按你的 Q5 决策（先报告 → 你 review → 再动手）：

| 阶段 | 内容 | 风险 | 前置 |
|---|---|---|---|
| **0** | **你 review 本报告**，确认/否决各条 | — | — |
| **1** | **方案 C 验证**：检查 Cloudflare 配置（`Cache Rules`、是否开 Cache Everything / Rocket Loader） | 无（只读） | 阶段 0 |
| **2** | **可观测性最小集**（§5）：`/ready` + TTFT/首字节埋点 | 低 | 阶段 0 |
| **3** | **方案 A 两段式超时** + 补 stall 测试 | 低-中 | 阶段 2（有埋点才能验证收益） |
| **4** | H2 限流评估（**仅在实测到 429 时**） | 极低 | 阶段 2 数据 |
| **5** | `transform.js` 重构（**建议推迟**，见 §4） | 中-高 | d-1~d-4 |

**我的核心建议**：**只做阶段 1~3**。阶段 1 可能零成本拿到最大收益（如果 Cloudflare 有干扰配置），阶段 2 让你能测量，阶段 3 服务你的北极星。**阶段 4 观察，阶段 5 推迟。**

---

*报告完。等你 review。*
