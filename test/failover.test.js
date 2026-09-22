import { test } from "node:test";
import assert from "node:assert/strict";
import { runFailover } from "../src/core/failover.js";

// outcome 构造器 —— 对齐 core/failover.js 的闭合四元组（done / skip / switch / retry）。
const okResp = (text = "ok") => new Response(text, { status: 200 });
const fail = (status, text, json = null) => ({
  status, text, json,
  response: new Response(text, { status })
});
const done = (text = "ok") => ({ kind: "done", response: okResp(text) });
const skip = (reason = "n/a") => ({ kind: "skip", reason });
const sw = (f) => ({ kind: "switch", fail: f });
const retry = (f, delayMs = 0) => ({ kind: "retry", fail: f, delayMs });

test("runFailover returns the first done response", async () => {
  const seen = [];
  const res = await runFailover(["a", "b"], {
    attempt: async (item, index) => {
      seen.push([item, index]);
      if (item === "a") return sw(fail(429, "rate limit"));
      return done("from-b");
    },
    onRetryable: async () => {}
  });
  assert.equal(await res.text(), "from-b");
  assert.deepEqual(seen, [["a", 0], ["b", 1]]);
});

test("runFailover returns fatal response immediately without touching later items", async () => {
  const seen = [];
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      seen.push(item);
      return sw(fail(400, "bad request"));
    }
  });
  assert.equal(res.status, 400);
  assert.deepEqual(seen, ["a"]);
});

test("runFailover treats thrown errors as transport failures and continues", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      if (item === "a") throw new Error("socket hang up");
      return done();
    },
    retryBudget: 0
  });
  assert.equal(await res.text(), "ok");
});

test("runFailover skips skip outcomes without recording failure", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => (item === "a" ? skip("no token") : done())
  });
  assert.equal(await res.text(), "ok");
});

test("runFailover returns last failure response when exhausted", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => sw(fail(429, `limited-${item}`))
  });
  assert.equal(res.status, 429);
  assert.equal(await res.text(), "limited-b");
});

test("runFailover calls renderExhausted when no failure was recorded", async () => {
  const res = await runFailover(["a"], {
    attempt: async () => { throw new Error("boom"); },
    renderExhausted: ({ lastError }) => new Response(`exhausted: ${lastError.message}`, { status: 502 }),
    retryBudget: 0
  });
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "exhausted: boom");
});

// ---- 回归：最后一项抛错时不得返回更早 fail 的预渲染响应 ----
test("runFailover surfaces last transport error over an earlier fail", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      if (item === "a") return sw(fail(429, "earlier-limited"));
      throw new Error("socket hang up on b");
    },
    retryBudget: 0
  });
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.match(body, /socket hang up on b/, "the last (real) error must win");
  assert.doesNotMatch(body, /earlier-limited/, "stale earlier failure must not be reported");
});

test("runFailover still returns last fail response when last failure is a fail", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      if (item === "a") throw new Error("socket hang up on a");
      return sw(fail(429, "later-limited"));
    },
    retryBudget: 0
  });
  assert.equal(res.status, 429);
  assert.equal(await res.text(), "later-limited");
});

test("runFailover rethrows when isAbort matches", async () => {
  const abort = new DOMException("aborted", "AbortError");
  await assert.rejects(
    runFailover(["a", "b"], {
      attempt: async () => { throw abort; },
      isAbort: (err) => err?.name === "AbortError"
    }),
    (err) => err === abort
  );
});

test("runFailover reports retry vs cooldown actions to onRetryable", async () => {
  const actions = [];
  await runFailover(["a", "b"], {
    attempt: async () => sw(fail(500, "boom")),
    onRetryable: async (item, action) => { actions.push([item, action]); }
  });
  assert.deepEqual(actions, [["a", "retry"], ["b", "retry"]]);
});

// ---- 新协议：retry 预算与 skip ----

test("runFailover re-attempts the SAME item on a retry outcome within budget", async () => {
  const seen = [];
  const res = await runFailover(["a"], {
    attempt: async (item, index) => {
      seen.push([item, index]);
      if (seen.length === 1) return retry(fail(503, "jitter"), 0);
      return done("recovered");
    },
    retryBudget: 1
  });
  assert.equal(await res.text(), "recovered");
  assert.deepEqual(seen, [["a", 0], ["a", 0]], "same item retried, index unchanged");
});

test("runFailover escalates an exhausted retry to switch (classified)", async () => {
  const actions = [];
  const res = await runFailover(["a"], {
    attempt: async () => retry(fail(503, "always"), 0),
    retryBudget: 2,
    onRetryable: async (item, action) => { actions.push([item, action]); }
  });
  // 3 次尝试（首次 + 2 次预算）后预算耗尽，503 被 classify 为 retry
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], ["a", "retry"]);
  assert.equal(res.status, 503);
});

test("runFailover retryBudget:0 means never re-attempt in place", async () => {
  let calls = 0;
  await runFailover(["a"], {
    attempt: async () => { calls++; return retry(fail(503, "jitter"), 0); },
    retryBudget: 0
  });
  assert.equal(calls, 1, "budget 0 must not retry");
});

test("runFailover sends skip through onRetryable-free path (no penalty)", async () => {
  const actions = [];
  const res = await runFailover(["a"], {
    attempt: async () => skip("missing-token"),
    onRetryable: async (item, action) => { actions.push([item, action]); },
    renderExhausted: () => new Response("all-skipped", { status: 502 })
  });
  assert.deepEqual(actions, [], "skip must not report a retryable action");
  assert.equal(await res.text(), "all-skipped");
});

test("runFailover honors fail.force=retry on a fatal-status switch", async () => {
  const seen = [];
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      seen.push(item);
      if (item === "a") return sw({ ...fail(404, "model gone"), force: "retry" });
      return done("from-b");
    }
  });
  assert.equal(await res.text(), "from-b");
  assert.deepEqual(seen, ["a", "b"]);
});

test("runFailover aborts during a pending retry delay (mid-flight, not pre-check)", async () => {
  const ac = new AbortController();
  let attempts = 0;
  const p = runFailover(["a"], {
    attempt: async () => { attempts++; return retry(fail(503, "jitter"), 30); },
    retryBudget: 1,
    signal: ac.signal
  });
  // 关键：等一个 tick 让 waitOrAbort 真正创建 timer，再 abort —— 覆盖 timer-cleanup 分支，
  // 而非 waitOrAbort 开头的 signal.aborted 预检分支。
  await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  await assert.rejects(p, (err) => err?.name === "AbortError");
  assert.equal(attempts, 1, "abort must prevent the in-place re-attempt");
});
