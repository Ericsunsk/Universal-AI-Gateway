import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UPSTREAM_ERR_MAX,
  errorBody,
  upstreamErrorBody,
  lastFailureDetail,
} from "../src/http/redact.js";
import { runFailover } from "../src/core/failover.js";
import { dispatchExchange } from "../src/exchange/exchange.js";
import { WorkBuddyProvider } from "../src/providers/workbuddy/index.js";

// C2：客户端可见失败走同一错误信封 {error:{message}}，原文恰好脱敏一次。

const LEAK = "auth failed for key sk-ant-abcdef123456789 at https://internal.corp.local/v1 from 10.0.0.7";

function assertEnvelopeJson(bodyText) {
  const parsed = JSON.parse(bodyText);
  assert.deepEqual(Object.keys(parsed), ["error"], "envelope must be exactly {error:{message}}");
  assert.equal(typeof parsed.error.message, "string");
  return parsed.error.message;
}

test("C2: envelope helpers redact exactly once with a visible truncation policy", () => {
  assert.ok(Number.isFinite(UPSTREAM_ERR_MAX), "truncation policy is part of the interface");
  const msg = assertEnvelopeJson(upstreamErrorBody(LEAK));
  assert.ok(!msg.includes("internal.corp.local") && !msg.includes("sk-ant-abcdef123456789") && !msg.includes("10.0.0.7"));
  assert.ok(msg.includes("<url>") && msg.includes("<credential>") && msg.includes("<ip>"));
  // 幂等：已脱敏文本不再变化（无 double-redact 漂移）
  assert.equal(upstreamErrorBody(msg), upstreamErrorBody(LEAK), "redaction must be idempotent");
  // 截断可见：超长原文收敛到 UPSTREAM_ERR_MAX
  const long = assertEnvelopeJson(upstreamErrorBody("x".repeat(500)));
  assert.ok(long.length <= UPSTREAM_ERR_MAX);
  // 可信文本直包不脱敏
  assert.deepEqual(JSON.parse(errorBody("plain 400: bad param")), { error: { message: "plain 400: bad param" } });
});

test("C2: dispatch upstream 4xx returns the shared envelope (redacted once)", async () => {
  const fakeFleet = {
    getProvider: () => ({
      type: "openai",
      callChat: async () => new Response(LEAK, { status: 400 }),
    }),
  };
  const res = await dispatchExchange({
    protocol: "openai",
    request: new Request("http://localhost/v1/chat/completions", { method: "POST" }),
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    model: "m",
    config: { routes: { m: [{ provider: "fake", model: "m" }] } },
    fleet: fakeFleet,
  });
  assert.equal(res.status, 400);
  const msg = assertEnvelopeJson(await res.text());
  assert.ok(msg.includes("<url>") && msg.includes("<credential>") && !msg.includes(LEAK));
});

test("C2: workbuddy fail.response uses the shared envelope (not plain text)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(LEAK, { status: 400 });
  try {
    const p = new WorkBuddyProvider(
      { id: "wb-c2", config: { accounts: [{ id: "c2a", userId: "u", accessToken: "t" }] } },
      {}
    );
    const out = await p.attemptAccount({ id: "c2a", userId: "u", accessToken: "t" }, {}, "{}", {});
    assert.equal(out.kind, "switch");
    assert.equal(out.fail.status, 400);
    assert.equal(out.fail.text, LEAK, "evidence text stays raw for the classifier");
    const msg = assertEnvelopeJson(await out.fail.response.text());
    assert.ok(msg.includes("<url>") && !msg.includes("internal.corp.local"));
  } finally {
    globalThis.fetch = orig;
  }
});

test("C2: failover exhausted fallback redacts lastError.message (was raw)", async () => {
  const res = await runFailover(["a"], {
    attempt: async () => { throw new Error(`socket hang up at https://internal.corp.local/x`); },
    retryBudget: 0,
  });
  assert.equal(res.status, 502);
  const msg = assertEnvelopeJson(await res.text());
  assert.ok(msg.includes("All candidates failed"), "fallback prefix preserved");
  assert.ok(msg.includes("<url>") && !msg.includes("internal.corp.local"), "transport error detail is redacted");
});

test("C2: lastFailureDetail prefers the last failure and redacts once", () => {
  assert.ok(lastFailureDetail(new Error("boom"), { text: "older" }).includes("boom"));
  assert.ok(!lastFailureDetail(null, { text: LEAK }).includes("internal.corp.local"));
  assert.equal(lastFailureDetail(null, null), "none");
});
