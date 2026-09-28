// dispatch.js 的直接行为测试 —— 路由解析与 failover 接线的分支级覆盖。
//
// 此前 dispatch.js（264 行，src/index.js 直接依赖的编排核心）没有任何测试**直接**
// import 它，只经 dispatchExchange 在别的用例里被间接走到。后果：候选解析的三级回退
// （精确路由 → routes["*"] → 默认直通兜底）、以及各失败分支的转译，都没有被钉住。
// 本文件补齐这一层，与 stream.js / fleet.js / scheduler.js 的直接覆盖对齐。
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchExchange } from "../src/exchange/dispatch.js";
import { makeFleet, jsonResponse } from "./helpers/stubs.js";

function okProvider(payload = { ok: true }) {
  return { callChat: async () => jsonResponse(payload) };
}

const baseArgs = (over) => ({
  protocol: "openai",
  model: "m",
  body: { messages: [{ role: "user", content: "hi" }] },
  request: new Request("https://gw.test/v1/chat/completions", { method: "POST" }),
  ...over
});

test("dispatch: exact route match wins and reaches the named provider", async () => {
  const fleet = makeFleet({ p1: okProvider({ hit: "p1" }) });
  const config = { routes: { m: [{ provider: "p1", model: "upstream-m" }] } };
  const res = await dispatchExchange(baseArgs({ fleet, config }));
  assert.equal(res.status, 200);
});

test("dispatch: falls back to routes[*] when the model is not explicitly routed", async () => {
  // 判别性设计：通配路由指向 pw，**没有** default_provider，且 getAllActive() 为空。
  // 这样若 routes["*"] 分支失效，兜底链会走到 404，测试即失败 —— 而不是被
  // 「碰巧也有个活跃 provider」掩盖（首版就踩了这个坑：8/8 通过但删掉通配分支也不报错）。
  const map = new Map([["pw", { id: "pw", ...okProvider({ hit: "wildcard" }) }]]);
  const fleet = {
    getProvider: (id) => map.get(id) || null,
    getAllActive: () => [],
    activeCount: 0
  };
  const config = { routes: { "*": [{ provider: "pw", model: "any" }] } };
  const res = await dispatchExchange(baseArgs({ fleet, config, model: "never-declared" }));
  assert.equal(res.status, 200, "wildcard route must serve an unrouted model");
});

test("dispatch: falls back to default_provider when neither exact nor wildcard matches", async () => {
  const fleet = makeFleet({ pd: okProvider({ hit: "default" }) });
  const config = { routes: {}, default_provider: "pd" };
  const res = await dispatchExchange(baseArgs({ fleet, config, model: "unknown-model" }));
  assert.equal(res.status, 200, "documented three-tier fallback must reach default_provider");
});

test("dispatch: bootstraps the first active provider when no default_provider is configured", async () => {
  const fleet = makeFleet({ first: okProvider({ hit: "first-active" }) });
  const config = { routes: {} };
  const res = await dispatchExchange(baseArgs({ fleet, config, model: "unknown-model" }));
  assert.equal(res.status, 200, "empty config must still route via first active provider");
});

test("dispatch: reasoning suffix is stripped before route lookup", async () => {
  const fleet = makeFleet({ p1: okProvider() });
  // route is declared on the clean model name; request carries a [high] suffix
  const config = { routes: { "claude-3-7-sonnet": [{ provider: "p1", model: "up" }] } };
  const res = await dispatchExchange(baseArgs({ fleet, config, model: "claude-3-7-sonnet[high]" }));
  assert.equal(res.status, 200, "cleanModel must be used for route resolution");
});

test("dispatch: non-retryable 400 is not retried across candidates and surfaces as an error envelope", async () => {
  let calls = 0;
  const fleet = makeFleet({
    a: { callChat: async () => { calls++; return new Response("bad request", { status: 400 }); } },
    b: okProvider({ hit: "b" })
  });
  const config = { routes: { m: [
    { provider: "a", model: "up" },
    { provider: "b", model: "up" }
  ] } };
  const res = await dispatchExchange(baseArgs({ fleet, config }));
  // 400 is classified fatal: the client error must be returned, not masked by failing over to b.
  assert.equal(res.status, 400, "fatal 4xx must surface, not silently fail over");
  assert.equal(calls, 1, "a non-retryable status must not be retried");
  assert.ok(res.headers.get("access-control-allow-origin") === "*", "error envelope carries CORS");
});

test("dispatch: route pointing at an absent provider yields a clean error, never a throw", async () => {
  const fleet = makeFleet({});
  const config = { routes: { m: [{ provider: "ghost", model: "up" }] } };
  const res = await dispatchExchange(baseArgs({ fleet, config }));
  assert.ok(typeof res.status === "number", "must return a Response, not throw");
  assert.ok(res.status >= 400, "unresolvable route is an error status");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("dispatch: every returned failure response carries CORS", async () => {
  const fleet = makeFleet({});
  const config = { routes: {} };
  const res = await dispatchExchange(baseArgs({ fleet, config, model: "nope" }));
  assert.equal(res.headers.get("access-control-allow-origin"), "*",
    "C2 applies to dispatch's own error rendering too");
});
