# CONTEXT.md — worker-ai-gateway

Domain glossary for the Universal AI Gateway. These terms carry load-bearing meaning in the code; use them consistently when navigating or extending the system.

## Module layout (DDD-lite: one context, role-based folders)

- `src/core/` — shared kernel, no adapter imports: `contract` (capability predicates), `scheduler` (pure account scheduling), `failover` (shared attempt loop), `tokenizer` (gpt-4o BPE token estimation). Kernel imports are restricted to `./` (within core) or the leaf layers `logging` / `http` / `kv` / `config`; enforced by `test/arch-c6-kernel-purity.test.js`.
- `src/providers/` — upstream adapters only: one directory per multi-file provider (`workbuddy/`, with an `index.js` adapter entry), single-file adapters (`openai_standard.js`, `anthropic_standard.js`), `registry.js` (type → constructor map) + `index.js` (built-in wiring), and `fleet.js` (provider orchestration — instantiates the fleet, so it lives here rather than in the kernel). Convention for new providers: new directory + `index.js` + one `registerProvider` line; shared kernel lives in `src/core/`, never in provider dirs.
- `src/exchange/` — protocol translation context: `transform` / `stream` / `dispatch` (+ `exchange.js` facade), `reasoning`, `sanitizer` (vendors-neutral output pruning only).
- `src/config/`, `src/auth/`, `src/http/` — single-responsibility modules; `src/index.js` is the core Fetch handler, `api/index.js` the Vercel serverless entry.
- `src/kv/` — persistence seam: `get` / `put` / `delete` (+ `json`) and `limit` behind one interface; memory / Upstash (via `@upstash/redis` and `@upstash/ratelimit`) adapters inside. Constructed once at the entry (`createKvFromEnv`), injected via env — core never imports adapters directly.

### Architecture invariants (C1–C6)

A **C-constraint** is a load-bearing structural rule that is machine-checked by an
`test/arch-cN-*.test.js` invariant test and recorded in an ADR. `C<N>` = the ADR
number minus 3 — i.e. the constraints were carved out of ADR-0004..0009 in order.
**Adding a new architectural invariant means: write the next ADR, then add
`test/arch-c<N+1>-*.test.js` carrying the `C<N+1>` label in its title.** A
constraint with no ADR, or an ADR whose rule has no test, is an incomplete
change — the rule will drift exactly as C6's did before it existed.

| C | Rule | ADR | Guard test |
|---|---|---|---|
| C1 | SSE 行源收敛为单一读循环 (`iterSseParsedChunks`) | 0004 | `arch-c1-linesource` |
| C2 | 客户端可见错误一律经 `src/http/redact.js` 信封 | 0005 | `arch-c2-envelope` |
| C3 | fail 构造收归 failover driver（`buildFail` 唯一构造点） | 0006 | `arch-c3-fail` |
| C4 | Fleet 重建规则显式化为 `FleetConfig` 值对象 | 0007 | `arch-c4-fleet` |
| C5 | 11148 消息序列收归单一序列模块 | 0008 | `arch-c5-sequence` |
| C6 | `src/core/` 不得 import adapters（依赖白名单 + 叶子层） | 0009 | `arch-c6-kernel-purity` |

### Module-level mutable state (convention)

Several modules keep process-lifetime mutable state at **module scope** (not on
`this`), keyed by `${providerId}_${accountId}`: `memoryTokenCache` /
`noCredentialWarned` / `inflightTokenRefresh` (`src/providers/workbuddy/index.js`),
`accountCooldownRecord` (`src/providers/workbuddy/cooldown.js`), `dnsCache`
(`src/providers/urlGuard.js`), `balanceCache` (`src/providers/fleet.js`).

This is **deliberate and correct**: the state must survive provider-instance
rebuild (fleet reconstruction on config change), and `cacheKey` is namespaced by
provider id so no two tenants share an entry. `inflightTokenRefresh` in
particular relies on being module-level — that is what makes token refresh
**single-flight across instances**, deduplicating upstream refresh calls. Moving
it onto `this` would silently regress performance (one refresh per instance);
moving `memoryTokenCache` onto `this` is safe but must come with instance-level
cleanup.

**Rule for new state:** only hoist to module scope when it must outlive an
instance rebuild, always namespace the key by provider id, and keep a bounded
cache bounded (see `dnsCache` / `balanceCache` for the LRU pattern).

## Core concepts

- **route** — a `model name → ordered candidate list` mapping (config `routes`). The unit of *model resolution*: a client asks for a logical model name, the gateway walks its candidates in order. Resolution is three-level: exact match (after reasoning-suffix strip) → wildcard `routes["*"]` (candidate `model` defaults to the requested name) → default passthrough to `config.default_provider` (empty means first active provider; absent provider means 404).

- **candidate** — a `{ provider, model }` pair tried in sequence during failover. One route has many candidates.

- **provider** — an adapter over one upstream AI service (WorkBuddy/Tencent, an OpenAI-compatible endpoint, or an Anthropic-compatible endpoint). Concrete implementations: `WorkBuddyProvider`, `OpenAIStandardProvider`, `AnthropicStandardProvider`.

- **fleet** — the collection of providers plus load-balancing/health/scheduling behavior (`ProviderFleet`). The one place that dispatches to providers by model.

- **fleet-config** — the explicit rebuild-identity value for the fleet cache (`toFleetConfig(config, env)` → `{ version, hash, env, ref }` in `src/core/fleet.js`). Callers pass `(config, env)`; comparison lives inside via `fleetConfigEquals`. A hit reuses the singleton, a miss rebuilds.

- **fleet fingerprint** — the `hash` inside fleet-config: key-order-normalized snapshot of `providers` plus `usage_provider_id`. Any drift (including credentials) changes fleet identity; field-allowlist enumeration is abolished.

- **provider contract** — the documented shape of what a provider adapter may implement (`src/core/contract.js`). Capability predicates (`hasGetBalance`/`hasDailyCheckin`/`hasCallChat`/`hasCallMessages`/`wantsStreamedChat`/`hasTokenRefresh`) replace hand-written `typeof` probes and `provider.type` switches. Dispatch probes capabilities, never the tag; `callChat` vs `callMessages` is decided by `hasCallMessages`, forced streaming by the adapter-declared `forceStream` flag.

- **account** — one WorkBuddy credential inside a provider's `accounts` pool (`{ id, userId, accessToken, refreshToken }`). Multi-account round-robin happens at the account level, *below* the provider level.

- **account scheduler** — the pure-function module (`src/core/scheduler.js`) that owns account selection, exponential backoff, and error classification. Its functions (`orderAccounts`, `computeCooldown`, `classify`, `businessErrorCode`) have no I/O side effects; cooldown state is passed in as a `Map` and mutated by the caller (`workbuddy/index.js`).

- **cooldown** — a per-account exponential-backoff record (`{ expiresAt, streak }`). `streak` increments on each punishable failure; backoff = `2^(streak-1)` minutes, capped at 8. A cooled-down account is skipped until `expiresAt` passes.

- **failover** — the shared attempt loop (`src/core/failover.js` `runFailover`): try items in order, classify each failure, switch item (cooling down the account on punishable failures), and only return the error when it's `fatal` or the pool is exhausted. Both the workbuddy account loop and the dispatch candidate loop leverage it; per-item behavior lives in the caller's `attempt`, retryable side effects in `onRetryable`.

## Protocol translation (`src/exchange/`)

Module layout: `transform.js` (request-side: transform / normalize / prune), `reduce.js` (response-side: pure reduction, block state machine, extractors, line-source), `stream.js` (response-side: I/O orchestration, keepalive, stall breaker), `dispatch.js` (route resolution and failover). `exchange.js` is a re-export facade; import from it to stay decoupled from the layout.

- **exchange / dispatch** — the layer that translates between the client-facing protocol (Anthropic or OpenAI) and the upstream protocol, in both directions. Debug attribution (`X-Gateway-Account/Model/Fallback`) is master-gated: `dispatchExchange` takes the caller `principal` and only emits these headers for `isMaster`; the WorkBuddy `accountResponse` seam honors the same flag via `options.principal`.

- **sanitize** — vendor-neutral output pruning in `src/exchange/sanitizer.js` (`optimizeToolOutput`, consumed by transform). Upstream-specific fingerprint defusing (Tencent 11128) lives with its owner in `src/providers/workbuddy/sanitize.js` — providers never import from exchange.

- **normalize** — reordering OpenAI `tool_calls`/`tool_results` to satisfy upstream message-sequence rules (Tencent error `11148`). `normalizeOpenAIMessages`.

- **transform** — the request-side mapping: Anthropic `tool_use`/`tool_result` blocks → OpenAI `tool_calls`/`tool` messages, and vice versa for the response.

- **reduce** — 纯分类器（`reduceOpenAIChunkAll` in `src/exchange/reduce.js`）：单个已解析 chunk → 按序发射数组
  （thinking / text / tool_use / finish）。流式与非流式两条消费路径都遍历数组，不再各写字段读取；
  error 独占。最高回归面（tool-use 交错、thinking 切换、stop 映射）至此可当纯数据单测。

- **shared extractors** — small pure helpers shared by the streaming and non-streaming paths to avoid divergent implementations: `extractErrorMessage`, `isUpstreamError`, `extractUsage` (`src/exchange/reduce.js`).

- **reasoning intent** — one parse per request (`parseReasoningIntent` in `src/exchange/reasoning.js`): model-suffix / Anthropic thinking / `reasoning_effort` / generic `reasoning` all normalize to `{ enabled, level, budgetTokens }`. Dispatch parses once and applies the intent exactly once per request (`transformAnthropicToOpenAI` 输出已含 OpenAI 映射，不二次 apply；唯 WorkBuddy 方言需清洗）。

- **line-source** — the shared upstream-SSE parsed-chunk source (`iterSseParsedChunks` in `src/exchange/reduce.js`): powered by industry-standard `eventsource-parser` with full W3C SSE compliance (handling CRLF, multi-line data, comments, keepalives, and multi-byte UTF-8 split reads). Yields `{ parsed, rawLine }` with bad-line warning caps; safely exports unparsed payload via `tail` for robust single-JSON fallbacks (even when terminated with newlines).

- **message sequence** — the single owner of OpenAI message ordering (`OpenAIMessageSequence` in `src/exchange/transform.js`): tool fan-out and `11148` re-hanging are its internals, exposed only as `appendToolExchange` + `finalize`.

- **tool exchange** — one atomic tool exchange: assistant `tool_calls` → companion tool results → trailing image `user` message last. Callers never send the parts separately.

- **error envelope** — the single client-visible failure shape `{error:{message}}`, constructed in `src/http/redact.js` (`errorBody` / `upstreamErrorBody`). Callers pass raw text; the envelope module redacts exactly once (**redact-once**, truncation `UPSTREAM_ERR_MAX` included).

## Classification vocabulary (in the scheduler)

- **cooldown** — a *punishable* failure (429, 402/403, quota, safety/compliance filter, Tencent business error). Cool the account down, then switch.
- **retry** — a *transient* server failure (5xx). Switch account without punishment.
- **fatal** — an unrecoverable client error (4xx other than 402/403/429). Return to the client.
- **attempt** — a single network round-trip against one candidate: one fetch, no sleep, no inner loop. It maps that one round-trip to exactly one **outcome**. (Distinct from *candidate*: one candidate may be attempted more than once.)
- **outcome** — the closed vocabulary an **attempt** returns to the failover driver: `done` (usable response), `skip` (never tried — e.g. missing credential; no penalty), `switch` (hand raw evidence to the driver's `classifyFailure`), or `retry` (transient transport/5xx wobble; asking the driver to re-attempt the same candidate). Only the driver interprets outcomes; an adapter never classifies.
- **retry budget** — the driver-owned cap on in-place re-attempts of one candidate (`retry` outcomes). The adapter requests a retry; the driver decides whether the budget allows it, owns the delay and the abort check. When the budget is spent, the attached fail escalates to `switch` and is classified like any other failure.

- **fail evidence** — the raw evidence an attempt hands the driver (`{status, text, json?}` plus `force` / render hint), never a pre-rendered `response`.

- **buildFail** — the driver's sole fail constructor (`src/core/failover.js`): evidence plus render caliber yields the canonical fail.

- **canonical fail** — a driver-completed fail: evidence fields plus a guaranteed `response`. `onRetryable` and exhausted handling consume only this shape.

- **renderFail** — the caller-declared failure-rendering caliber `(fail, item, index) => Response` (dispatch CORS envelope / workbuddy account attribution); a per-fail `render` hint takes precedence over it.
