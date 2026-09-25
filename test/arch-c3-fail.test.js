import { test } from "node:test";
import assert from "node:assert/strict";
import { runFailover, buildFail } from "../src/core/failover.js";

// C3：attempt 只交原始证据，fail 对象与预渲染 response 由 driver 构造。
// outcome 词汇（done/skip/switch/retry）与 retryBudget/signal/force 语义保持不变。

const done = (text = "ok") => ({ kind: "done", response: new Response(text, { status: 200 }) });

test("C3: buildFail keeps raw evidence and pre-renders a redacted envelope", async () => {
  const fail = buildFail({ status: 400, text: "bad https://internal.corp.local/x" });
  assert.equal(fail.status, 400);
  assert.equal(fail.text, "bad https://internal.corp.local/x", "classifier sees raw text");
  assert.ok(fail.response instanceof Response);
  const body = await fail.response.json();
  assert.ok(body.error.message.includes("<url>"), "rendered response is redacted once");
  assert.ok(!body.error.message.includes("internal.corp.local"));
});

test("C3: evidence-only switch fatal returns a driver-built response, skips later items", async () => {
  const seen = [];
  const res = await runFailover(["a", "b"], {
    retryBudget: 0,
    attempt: async (item) => {
      seen.push(item);
      return { kind: "switch", fail: { status: 400, text: "bad param" } }; // 无 response
    },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(seen, ["a"], "fatal must not touch later items");
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"], "driver-built response uses the shared envelope");
  assert.ok(body.error.message.includes("bad param"));
});

test("C3: evidence-only fatal with force=retry still switches (force semantics unchanged)", async () => {
  const seen = [];
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      seen.push(item);
      if (item === "a") return { kind: "switch", fail: { status: 404, text: "model gone", force: "retry" } };
      return done("from-b");
    },
  });
  assert.equal(await res.text(), "from-b");
  assert.deepEqual(seen, ["a", "b"]);
});

test("C3: outcome.evidence alias is accepted as raw evidence", async () => {
  const res = await runFailover(["a", "b"], {
    retryBudget: 0,
    attempt: async (item) => {
      if (item === "a") return { kind: "switch", evidence: { status: 429, text: "limited" } };
      return done("from-b");
    },
  });
  assert.equal(await res.text(), "from-b");
});

test("C3: driver-level renderFail renders evidence-only fails", async () => {
  const res = await runFailover(["a"], {
    retryBudget: 0,
    renderFail: (fail, item, index) =>
      new Response(`rendered:${item}:${index}:${fail.status}:${fail.text}`, { status: fail.status }),
    attempt: async () => ({ kind: "switch", fail: { status: 400, text: "raw-evidence" } }),
  });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "rendered:a:0:400:raw-evidence");
});

test("C3: per-fail render hint wins over driver-level renderFail", async () => {
  const res = await runFailover(["a"], {
    retryBudget: 0,
    renderFail: () => new Response("driver-level", { status: 500 }),
    attempt: async () => ({
      kind: "switch",
      fail: {
        status: 400,
        text: "x",
        render: () => new Response("per-fail-hint", { status: 400 }),
      },
    }),
  });
  assert.equal(await res.text(), "per-fail-hint");
});

test("C3: legacy fail with pre-rendered response is preserved as-is", async () => {
  const prebuilt = new Response("legacy-body", { status: 418 });
  const res = await runFailover(["a", "b"], {
    retryBudget: 0,
    attempt: async () => ({ kind: "switch", fail: { status: 418, text: "teapot", response: prebuilt } }),
  });
  assert.equal(res, prebuilt, "legacy pre-rendered response must not be rebuilt");
});

test("C3: exhausted evidence-only retry escalates with a driver-built response", async () => {
  const actions = [];
  const res = await runFailover(["a"], {
    retryBudget: 0, // 无原地重试预算：retry 直接升级为 switch 记录
    onRetryable: async (item, action) => { actions.push([item, action]); },
    attempt: async () => ({ kind: "retry", fail: { status: 503, text: "jitter" }, delayMs: 0 }),
  });
  assert.deepEqual(actions, [["a", "retry"]], "classification outcome unchanged (5xx -> retry)");
  assert.equal(res.status, 503, "driver-built response keeps the evidence status");
  const body = await res.json();
  assert.ok(body.error.message.includes("jitter"));
});

test("C3: retry budget still drives in-place re-attempts for evidence-only fails", async () => {
  const seen = [];
  const res = await runFailover(["a"], {
    retryBudget: 1,
    attempt: async (item, index) => {
      seen.push([item, index]);
      if (seen.length === 1) return { kind: "retry", fail: { status: 503, text: "jitter" }, delayMs: 0 };
      return done("recovered");
    },
  });
  assert.equal(await res.text(), "recovered");
  assert.deepEqual(seen, [["a", 0], ["a", 0]], "same item retried, index unchanged");
});

test("C3: fail without status never yields an undefined response (fatal defaults to 502 envelope)", async () => {
  const res = await runFailover(["a", "b"], {
    retryBudget: 0,
    attempt: async () => ({ kind: "switch", fail: { text: "no-status" } }),
  });
  assert.ok(res instanceof Response, "missing response on fatal is fixed by the driver");
  assert.equal(res.status, 502);
});
