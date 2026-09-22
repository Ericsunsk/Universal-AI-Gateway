import { test } from "node:test";
import assert from "node:assert/strict";
import { runFailover } from "../src/core/failover.js";

const okResp = (text = "ok") => new Response(text, { status: 200 });
const fail = (status, text, json = null) => ({
  status, text, json,
  response: new Response(text, { status })
});

test("runFailover returns the first done response", async () => {
  const seen = [];
  const res = await runFailover(["a", "b"], {
    attempt: async (item, index) => {
      seen.push([item, index]);
      if (item === "a") return { fail: fail(429, "rate limit") };
      return { done: okResp("from-b") };
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
      return { fail: fail(400, "bad request") };
    }
  });
  assert.equal(res.status, 400);
  assert.deepEqual(seen, ["a"]);
});

test("runFailover treats thrown errors as transport failures and continues", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      if (item === "a") throw new Error("socket hang up");
      return { done: okResp() };
    }
  });
  assert.equal(await res.text(), "ok");
});

test("runFailover skips null outcomes without recording failure", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => (item === "a" ? null : { done: okResp() })
  });
  assert.equal(await res.text(), "ok");
});

test("runFailover returns last failure response when exhausted", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => ({ fail: fail(429, `limited-${item}`) })
  });
  assert.equal(res.status, 429);
  assert.equal(await res.text(), "limited-b");
});

test("runFailover calls renderExhausted when no failure was recorded", async () => {
  const res = await runFailover(["a"], {
    attempt: async () => { throw new Error("boom"); },
    renderExhausted: ({ lastError }) => new Response(`exhausted: ${lastError.message}`, { status: 502 })
  });
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "exhausted: boom");
});

// ---- H1 回归：最后一项抛错时不得返回更早 fail 的预渲染响应 ----
test("runFailover surfaces last transport error over an earlier fail", async () => {
  const res = await runFailover(["a", "b"], {
    attempt: async (item) => {
      if (item === "a") return { fail: fail(429, "earlier-limited") };
      throw new Error("socket hang up on b");
    }
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
      return { fail: fail(429, "later-limited") };
    }
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
    attempt: async () => ({ fail: fail(500, "boom") }),
    onRetryable: async (item, action) => { actions.push([item, action]); }
  });
  assert.deepEqual(actions, [["a", "retry"], ["b", "retry"]]);
});
