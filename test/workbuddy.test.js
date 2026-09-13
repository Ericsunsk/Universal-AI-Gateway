import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkBuddyProvider } from "../src/providers/workbuddy/index.js";
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
