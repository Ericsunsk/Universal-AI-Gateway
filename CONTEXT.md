# CONTEXT.md — worker-ai-gateway

Domain glossary for the Universal AI Gateway. These terms carry load-bearing meaning in the code; use them consistently when navigating or extending the system.

## Core concepts

- **route** — a `model name → ordered candidate list` mapping (config `routes`). The unit of *model resolution*: a client asks for a logical model name, the gateway walks its candidates in order.

- **candidate** — a `{ provider, model }` pair tried in sequence during failover. One route has many candidates.

- **provider** — an adapter over one upstream AI service (WorkBuddy/Tencent, OpenRouter, an OpenAI-compatible endpoint, or an Anthropic-compatible endpoint). Concrete implementations: `WorkBuddyProvider`, `OpenAIStandardProvider`, `AnthropicStandardProvider`.

- **fleet** — the collection of providers plus load-balancing/health/scheduling behavior (`ProviderFleet`). The one place that dispatches to providers by model.

- **provider contract** — the documented shape of what a provider adapter may implement (`src/providers/contract.js`). Capability predicates (`hasGetBalance`/`hasOnSchedule`/`hasDailyCheckin`) replace hand-written `typeof` probes in `fleet.js`. `callChat`/`callMessages` dispatch is by `provider.type`, *not* capability probing.

- **account** — one WorkBuddy credential inside a provider's `accounts` pool (`{ id, userId, accessToken, refreshToken }`). Multi-account round-robin happens at the account level, *below* the provider level.

- **account scheduler** — the pure-function module (`src/providers/scheduler.js`) that owns account selection, exponential backoff, and error classification. Its functions (`orderAccounts`, `computeCooldown`, `classify`, `businessErrorCode`) have no I/O side effects; cooldown state is passed in as a `Map` and mutated by the caller (`workbuddy.js`).

- **cooldown** — a per-account exponential-backoff record (`{ expiresAt, streak }`). `streak` increments on each punishable failure; backoff = `2^(streak-1)` minutes, capped at 8. A cooled-down account is skipped until `expiresAt` passes.

- **failover** — the retry loop in `workbuddy.js` `callChat`: try accounts in scheduler order, classify each failure, switch account (or cool down + switch), and only return the error to the client when it's `fatal`.

## Protocol translation (`src/engine/exchange.js`)

- **exchange / dispatch** — the layer that translates between the client-facing protocol (Anthropic or OpenAI) and the upstream protocol, in both directions.

- **sanitize** — rewriting Claude-Code / client fingerprints to bypass upstream keyword filters (Tencent error `11128`). In `src/engine/sanitizer.js`.

- **normalize** — reordering OpenAI `tool_calls`/`tool_results` to satisfy upstream message-sequence rules (Tencent error `11148`). `normalizeOpenAIMessages`.

- **transform** — the request-side mapping: Anthropic `tool_use`/`tool_result` blocks → OpenAI `tool_calls`/`tool` messages, and vice versa for the response.

- **reduce** — the pure per-chunk classifier (`reduceOpenAIChunk`) that maps one parsed OpenAI SSE chunk → a typed emission (`error` / `thinking` / `text` / `tool_use`). The streaming state machine (`streamOpenAIToAnthropic`) consumes it, but the error-classification branch is the only part wired through the reducer today; text/thinking/tool-call emission remains inline.

## Classification vocabulary (in the scheduler)

- **cooldown** — a *punishable* failure (429, 403, quota, safety/compliance filter, Tencent business error). Cool the account down, then switch.
- **retry** — a *transient* server failure (5xx). Switch account without punishment.
- **fatal** — an unrecoverable client error (4xx other than 403/429). Return to the client.
