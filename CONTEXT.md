# CONTEXT.md — worker-ai-gateway

Domain glossary for the Universal AI Gateway. These terms carry load-bearing meaning in the code; use them consistently when navigating or extending the system.

## Module layout (DDD-lite: one context, role-based folders)

- `src/core/` — shared kernel, no adapter imports: `contract` (capability predicates), `scheduler` (pure account scheduling), `failover` (shared attempt loop), `fleet` (provider orchestration).
- `src/providers/` — upstream adapters only: one directory per multi-file provider (`workbuddy/`, with an `index.js` adapter entry), single-file adapters (`openai_standard.js`, `anthropic_standard.js`), `registry.js` (type → constructor map) + `index.js` (built-in wiring). Convention for new providers: new directory + `index.js` + one `registerProvider` line; shared kernel lives in `src/core/`, never in provider dirs.
- `src/exchange/` — protocol translation context: `transform` / `stream` / `dispatch` (+ `exchange.js` facade), `reasoning`, `sanitizer`.
- `src/config/`, `src/auth/`, `src/http/` — single-responsibility modules; `src/index.js` is the core Fetch handler, `api/index.js` the Vercel serverless entry.
- `src/kv/` — persistence seam: `get` / `put` / `delete` (+ `json`) behind one interface; memory / Upstash-REST / composite adapters inside. Constructed once at the entry (`createKvFromEnv`), injected via env — core never imports adapters directly.

## Core concepts

- **route** — a `model name → ordered candidate list` mapping (config `routes`). The unit of *model resolution*: a client asks for a logical model name, the gateway walks its candidates in order. Resolution is three-level: exact match (after reasoning-suffix strip) → wildcard `routes["*"]` (candidate `model` defaults to the requested name) → default passthrough to `config.default_provider` (empty means first active provider; absent provider means 404).

- **candidate** — a `{ provider, model }` pair tried in sequence during failover. One route has many candidates.

- **provider** — an adapter over one upstream AI service (WorkBuddy/Tencent, an OpenAI-compatible endpoint, or an Anthropic-compatible endpoint). Concrete implementations: `WorkBuddyProvider`, `OpenAIStandardProvider`, `AnthropicStandardProvider`.

- **fleet** — the collection of providers plus load-balancing/health/scheduling behavior (`ProviderFleet`). The one place that dispatches to providers by model.

- **provider contract** — the documented shape of what a provider adapter may implement (`src/core/contract.js`). Capability predicates (`hasGetBalance`/`hasDailyCheckin`/`hasCallChat`/`hasCallMessages`/`wantsStreamedChat`/`hasTokenRefresh`) replace hand-written `typeof` probes and `provider.type` switches. Dispatch probes capabilities, never the tag; `callChat` vs `callMessages` is decided by `hasCallMessages`, forced streaming by the adapter-declared `forceStream` flag.

- **account** — one WorkBuddy credential inside a provider's `accounts` pool (`{ id, userId, accessToken, refreshToken }`). Multi-account round-robin happens at the account level, *below* the provider level.

- **account scheduler** — the pure-function module (`src/core/scheduler.js`) that owns account selection, exponential backoff, and error classification. Its functions (`orderAccounts`, `computeCooldown`, `classify`, `businessErrorCode`) have no I/O side effects; cooldown state is passed in as a `Map` and mutated by the caller (`workbuddy/index.js`).

- **cooldown** — a per-account exponential-backoff record (`{ expiresAt, streak }`). `streak` increments on each punishable failure; backoff = `2^(streak-1)` minutes, capped at 8. A cooled-down account is skipped until `expiresAt` passes.

- **failover** — the shared attempt loop (`src/core/failover.js` `runFailover`): try items in order, classify each failure, switch item (cooling down the account on punishable failures), and only return the error when it's `fatal` or the pool is exhausted. Both the workbuddy account loop and the dispatch candidate loop leverage it; per-item behavior lives in the caller's `attempt`, retryable side effects in `onRetryable`.

## Protocol translation (`src/exchange/`)

Module layout: `transform.js` (request-side: transform / normalize / prune), `stream.js` (response-side: reduce / shared extractors / streaming + non-streaming translators), `dispatch.js` (route resolution and failover). `exchange.js` is a re-export facade; import from it to stay decoupled from the layout.

- **exchange / dispatch** — the layer that translates between the client-facing protocol (Anthropic or OpenAI) and the upstream protocol, in both directions. Debug attribution (`X-Gateway-Account/Model/Fallback`) is master-gated: `dispatchExchange` takes the caller `principal` and only emits these headers for `isMaster`; the WorkBuddy `accountResponse` seam honors the same flag via `options.principal`.

- **sanitize** — rewriting Claude-Code / client fingerprints to bypass upstream keyword filters (Tencent error `11128`). In `src/exchange/sanitizer.js`.

- **normalize** — reordering OpenAI `tool_calls`/`tool_results` to satisfy upstream message-sequence rules (Tencent error `11148`). `normalizeOpenAIMessages`.

- **transform** — the request-side mapping: Anthropic `tool_use`/`tool_result` blocks → OpenAI `tool_calls`/`tool` messages, and vice versa for the response.

- **reduce** — 纯分类器（`reduceOpenAIChunkAll` in `src/exchange/stream.js`）：单个已解析 chunk → 按序发射数组
  （thinking / text / tool_use / finish）。流式与非流式两条消费路径都遍历数组，不再各写字段读取；
  error 独占。最高回归面（tool-use 交错、thinking 切换、stop 映射）至此可当纯数据单测。

- **shared extractors** — small pure helpers shared by the streaming and non-streaming paths to avoid divergent implementations: `extractErrorMessage`, `isUpstreamError`, `extractUsage` (`src/exchange/stream.js`).

- **reasoning intent** — one parse per request (`parseReasoningIntent` in `src/exchange/reasoning.js`): model-suffix / Anthropic thinking / `reasoning_effort` / generic `reasoning` all normalize to `{ enabled, level, budgetTokens }`. Dispatch parses once and applies the intent exactly once per request (`transformAnthropicToOpenAI` 输出已含 OpenAI 映射，不二次 apply；唯 WorkBuddy 方言需清洗）。

## Classification vocabulary (in the scheduler)

- **cooldown** — a *punishable* failure (429, 402/403, quota, safety/compliance filter, Tencent business error). Cool the account down, then switch.
- **retry** — a *transient* server failure (5xx). Switch account without punishment.
- **fatal** — an unrecoverable client error (4xx other than 402/403/429). Return to the client.
- **attempt** — a single network round-trip against one candidate: one fetch, no sleep, no inner loop. It maps that one round-trip to exactly one **outcome**. (Distinct from *candidate*: one candidate may be attempted more than once.)
- **outcome** — the closed vocabulary an **attempt** returns to the failover driver: `done` (usable response), `skip` (never tried — e.g. missing credential; no penalty), `switch` (hand raw evidence to the driver's `classifyFailure`), or `retry` (transient transport/5xx wobble; asking the driver to re-attempt the same candidate). Only the driver interprets outcomes; an adapter never classifies.
- **retry budget** — the driver-owned cap on in-place re-attempts of one candidate (`retry` outcomes). The adapter requests a retry; the driver decides whether the budget allows it, owns the delay and the abort check. When the budget is spent, the attached fail escalates to `switch` and is classified like any other failure.
