import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkBuddyProvider, retryDelayMs, DEFAULT_RETRY_DELAY_MS } from "../src/providers/workbuddy/index.js";
import { accountCooldownRecord, hydrateCooldowns } from "../src/providers/workbuddy/cooldown.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// 按 URL 脚本化 fetch：chat 表列队，refresh 固定应答
function scriptFetch({ chat = [], refresh = null }) {
  const chatQueue = [...chat];
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/token/refresh")) {
      if (!refresh) throw new Error("unexpected refresh call");
      return new Response(JSON.stringify(refresh), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    const next = chatQueue.shift();
    if (!next) throw new Error("unexpected chat call");
    return next;
  };
}

const jsonResp = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json" }
});

function provider(id, accounts) {
  return new WorkBuddyProvider({ id, config: { accounts } }, {});
}

const acc = (id) => ({ id, userId: `u-${id}`, accessToken: `tok-${id}` });

test("attemptAccount returns done on first-try success", async () => {
  scriptFetch({ chat: [new Response("hello", { status: 200 })] });
  const p = provider("wb-t1", [acc("t1a")]);
  const out = await p.attemptAccount(acc("t1a"), {}, "{}", {});
  assert.ok(out.done, "expected done");
  assert.equal(out.done.status, 200);
  assert.equal(await out.done.text(), "hello");
});

test("attemptAccount refreshes token after 401 and retries", async () => {
  scriptFetch({
    chat: [new Response("expired", { status: 401 }), new Response("recovered", { status: 200 })],
    refresh: { code: 0, data: { accessToken: "new-tok", refreshToken: "new-ref" } }
  });
  const account = { ...acc("t2a"), refreshToken: "ref-t2a" };
  const p = provider("wb-t2", [account]);
  const out = await p.attemptAccount(account, {}, "{}", {});
  assert.ok(out.done, "expected done after refresh");
  assert.equal(await out.done.text(), "recovered");
});

test("attemptAccount returns null when 401 refresh fails (no cooldown streak)", async () => {
  scriptFetch({ chat: [new Response("expired", { status: 401 })] });
  const p = provider("wb-t3", [acc("t3a")]); // 无 refreshToken → 刷新直接返回 null
  const out = await p.attemptAccount(acc("t3a"), {}, "{}", {});
  assert.equal(out, null);
  assert.equal(accountCooldownRecord.has("t3a"), false, "401 must not punish streak");
});

test("attemptAccount surfaces 200 business-code as cooldown-classified fail", async () => {
  scriptFetch({ chat: [jsonResp(200, { code: 11140, msg: "quota done" })] });
  const p = provider("wb-t4", [acc("t4a")]);
  const out = await p.attemptAccount(acc("t4a"), { stream: true }, "{}", {});
  assert.ok(out.fail, "expected fail");
  assert.equal(out.fail.status, 200);
  assert.equal(out.fail.json.code, 11140);
  assert.equal(out.fail.response.status, 200);
});

test("attemptAccount surfaces fatal 400 for immediate return", async () => {
  scriptFetch({ chat: [new Response("bad param", { status: 400 })] });
  const p = provider("wb-t5", [acc("t5a")]);
  const out = await p.attemptAccount(acc("t5a"), {}, "{}", {});
  assert.ok(out.fail, "expected fail");
  assert.equal(out.fail.status, 400);
  assert.equal(out.fail.response.status, 400);
});

test("attemptAccount retries once on 502 jitter then succeeds", async () => {
  scriptFetch({ chat: [new Response("bad gateway", { status: 502 }), new Response("steady", { status: 200 })] });
  const p = provider("wb-t6", [acc("t6a")]);
  const out = await p.attemptAccount(acc("t6a"), {}, "{}", {});
  assert.ok(out.done, "expected done after jitter retry");
  assert.equal(await out.done.text(), "steady");
});

test("callChat cools the punished account and fails over to the next", async () => {
  scriptFetch({
    chat: [new Response("limited", { status: 429 }), new Response("served", { status: 200 })]
  });
  const p = provider("wb-t7", [acc("t7a"), acc("t7b")]);
  const res = await p.callChat({ messages: [] }, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "served");
  assert.ok(accountCooldownRecord.has("t7a"), "429 account must be cooling");
  assert.equal(accountCooldownRecord.has("t7b"), false, "healthy account must not cool");
});

test("retryDelayMs honors env override with safe fallback (Q6)", () => {
  assert.equal(DEFAULT_RETRY_DELAY_MS, 600);
  assert.equal(retryDelayMs({}), 600);
  assert.equal(retryDelayMs({ RETRY_BASE_MS: "200" }), 200);
  assert.equal(retryDelayMs({ RETRY_BASE_MS: 0 }), 0);
  assert.equal(retryDelayMs({ RETRY_BASE_MS: -5 }), 600, "negative clamps to default");
  assert.equal(retryDelayMs({ RETRY_BASE_MS: "junk" }), 600, "non-numeric falls back");
  assert.equal(retryDelayMs(null), 600);
});

test("RETRY_BASE_MS=0 makes jitter retry immediate", async () => {
  scriptFetch({ chat: [new Response("bad gateway", { status: 502 }), new Response("fast", { status: 200 })] });
  const p = new WorkBuddyProvider(
    { id: "wb-t9", config: { accounts: [acc("t9a")] } },
    { RETRY_BASE_MS: "0" }
  );
  const t0 = Date.now();
  const out = await p.attemptAccount(acc("t9a"), {}, "{}", {});
  assert.ok(out.done, "expected done after immediate retry");
  assert.ok(Date.now() - t0 < 500, "must not sleep the default 600ms");
});

test("clear skips KV delete without local record, deletes after real cooldown (Q5)", async () => {
  const ops = { delete: 0, put: 0 };
  const kv = {
    get: async () => null,
    put: async () => { ops.put++; },
    delete: async () => { ops.delete++; }
  };
  const p = new WorkBuddyProvider(
    { id: "wb-t8", config: { accounts: [{ id: "t8a", userId: "u", accessToken: "t" }] } },
    { GATEWAY_KV: kv }
  );
  // 成功且无冷却记录：零 KV 写
  scriptFetch({ chat: [new Response("ok", { status: 200 })] });
  const r1 = await p.callChat({ messages: [] }, {});
  assert.equal(r1.status, 200);
  assert.equal(ops.delete, 0, "no local record → no KV delete");
  assert.equal(ops.put, 0, "success → no KV put");
  // 429 落一次冷却（put 1 次），再成功一次 → 清掉它（delete 1 次）
  scriptFetch({ chat: [new Response("limited", { status: 429 })] });
  await p.callChat({ messages: [] }, {});
  assert.equal(ops.put, 1);
  scriptFetch({ chat: [new Response("ok2", { status: 200 })] });
  const r3 = await p.callChat({ messages: [] }, {});
  assert.equal(await r3.text(), "ok2");
  assert.equal(ops.delete, 1, "real record → KV delete happens");
});

test("hydrateCooldowns handles both parsed objects and string JSON from KV", async () => {
  const future = Date.now() + 60000;
  const mockKv = {
    async get(key, type) {
      if (key.includes("obj_acc")) return { expiresAt: future, streak: 1 };
      if (key.includes("str_acc")) return JSON.stringify({ expiresAt: future, streak: 2 });
      return null;
    }
  };
  await hydrateCooldowns({ GATEWAY_KV: mockKv }, [{ id: "obj_acc" }, { id: "str_acc" }], true);
  assert.equal(accountCooldownRecord.get("obj_acc")?.streak, 1);
  assert.equal(accountCooldownRecord.get("str_acc")?.streak, 2);
});
