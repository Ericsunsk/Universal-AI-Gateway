import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, withGate } from "../src/core/mutex.js";

test("withGate serializes concurrent executions", async () => {
  const gate = createGate();
  let concurrent = 0, maxSeen = 0;
  const job = async (ms) => withGate(gate, null, async () => {
    concurrent++;
    maxSeen = Math.max(maxSeen, concurrent);
    await new Promise(r => setTimeout(r, ms));
    concurrent--;
    return "ok";
  });
  const results = await Promise.all([job(30), job(20), job(10)]);
  assert.deepEqual(results, ["ok", "ok", "ok"]);
  assert.equal(maxSeen, 1, "never overlap");
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});

test("withGate drops aborted waiter without deadlock", async () => {
  const gate = createGate();
  const slow = withGate(gate, null, async () => {
    await new Promise(r => setTimeout(r, 40));
    return "slow";
  });
  const ctl = new AbortController();
  const queued = withGate(gate, ctl.signal, async () => "queued");
  // rejection 处理器必须立即挂载，否则 5ms 时的 abort 因无人认领被标 unhandledRejection
  const queuedSettled = assert.rejects(queued, /abort/i);
  const after = withGate(gate, null, async () => "after");
  setTimeout(() => ctl.abort(), 5);
  assert.equal(await slow, "slow");
  await queuedSettled;
  assert.equal(await after, "after", "later waiter proceeds after abort");
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});

test("withGate releases slot when body throws", async () => {
  const gate = createGate();
  await assert.rejects(withGate(gate, null, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withGate(gate, null, async () => "next"), "next");
});

test("qwenweb provider serializes burst through gate", async () => {
  const { QwenWebProvider } = await import("../src/providers/qwenweb/index.js");
  let concurrent = 0, maxSeen = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/v2/chats/new")) {
      return new Response('{"chat_id":"c1"}', { headers: { "Content-Type": "application/json" } });
    }
    concurrent++;
    maxSeen = Math.max(maxSeen, concurrent);
    await new Promise(r => setTimeout(r, 20));
    concurrent--;
    return new Response('data: {"type":"content","data":"x"}\n\ndata: {"type":"done"}\n\n', {
      headers: { "Content-Type": "text/event-stream" }
    });
  };
  const p = new QwenWebProvider({ id: "qw-gate", config: { token: "t" } }, {});
  const call = () => p.callChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { fetch: fetchImpl }).then(r => r.text());
  await Promise.all([call(), call(), call()]);
  assert.equal(maxSeen, 1, "upstream sees at most one in-flight per account");
});
