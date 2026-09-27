import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  WorkBuddyProvider,
  retryDelayMs,
  DEFAULT_RETRY_DELAY_MS,
  resetSchedulingCounterForTests,
  parseJwtExp,
  isJwtExpiringSoon,
  jwtRefreshBufferSec
} from "../src/providers/workbuddy/index.js";
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
  assert.equal(out.kind, "done");
  assert.equal(out.response.status, 200);
  assert.equal(await out.response.text(), "hello");
});

test("attemptAccount refreshes token after 401 and retries", async () => {
  scriptFetch({
    chat: [new Response("expired", { status: 401 }), new Response("recovered", { status: 200 })],
    refresh: { code: 0, data: { accessToken: "new-tok", refreshToken: "new-ref" } }
  });
  const account = { ...acc("t2a"), refreshToken: "ref-t2a" };
  const p = provider("wb-t2", [account]);
  const out = await p.attemptAccount(account, {}, "{}", {});
  assert.equal(out.kind, "done");
  assert.equal(await out.response.text(), "recovered");
});

test("attemptAccount returns skip when 401 refresh fails (no cooldown streak)", async () => {
  scriptFetch({ chat: [new Response("expired", { status: 401 })] });
  const p = provider("wb-t3", [acc("t3a")]); // 无 refreshToken → 刷新直接返回 null
  const out = await p.attemptAccount(acc("t3a"), {}, "{}", {});
  assert.equal(out.kind, "skip");
  assert.equal(accountCooldownRecord.has("t3a"), false, "401 must not punish streak");
});

test("attemptAccount surfaces 200 business-code as switch outcome", async () => {
  scriptFetch({ chat: [jsonResp(200, { code: 11140, msg: "quota done" })] });
  const p = provider("wb-t4", [acc("t4a")]);
  const out = await p.attemptAccount(acc("t4a"), { stream: true }, "{}", {});
  assert.equal(out.kind, "switch");
  assert.equal(out.fail.status, 200);
  assert.equal(out.fail.json.code, 11140);
  assert.equal(out.fail.response.status, 200);
});

test("attemptAccount surfaces fatal 400 as a switch outcome", async () => {
  scriptFetch({ chat: [new Response("bad param", { status: 400 })] });
  const p = provider("wb-t5", [acc("t5a")]);
  const out = await p.attemptAccount(acc("t5a"), {}, "{}", {});
  assert.equal(out.kind, "switch");
  assert.equal(out.fail.status, 400);
  assert.equal(out.fail.response.status, 400);
});

test("attemptAccount requests an in-place retry on 502 (driver owns the retry)", async () => {
  // 新协议：单次尝试只做一次往返并把 5xx 映射为 { kind:"retry" }，不再自己 sleep / 重发。
  scriptFetch({ chat: [new Response("bad gateway", { status: 502 })] });
  const p = provider("wb-t6", [acc("t6a")]);
  const out = await p.attemptAccount(acc("t6a"), {}, "{}", {});
  assert.equal(out.kind, "retry");
  assert.equal(out.fail.status, 502);
});

test("callChat retries jitter in place then succeeds (driver budget)", async () => {
  scriptFetch({ chat: [new Response("bad gateway", { status: 502 }), new Response("steady", { status: 200 })] });
  const p = new WorkBuddyProvider(
    { id: "wb-t6", config: { accounts: [acc("t6a")] } },
    { RETRY_BASE_MS: "0" }
  );
  const res = await p.callChat({ messages: [] }, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "steady");
});

test("callChat cools the punished account and fails over to the next", async () => {
  // 确定性：重置调度计数器后 rrIndex=0 起排，[t7a,t7b] 首试必为 t7a（429 惩罚对象唯一），
  // 恢复精确断言——若未来惩罚错对象（t7b 被冷却），本用例失败。
  resetSchedulingCounterForTests();
  accountCooldownRecord.delete("t7a");
  accountCooldownRecord.delete("t7b");
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

test("X-Gateway-Account attribution is master-only (client keys see nothing)", async () => {
  // master：归因头完整下发（含 retry 路径）
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/token/refresh")) throw new Error("unexpected refresh call");
    calls++;
    if (calls === 1) throw new Error("socket hang up");
    return new Response("recovered", { status: 200 });
  };
  const p = new WorkBuddyProvider(
    { id: "wb-t6b", config: { accounts: [acc("t6b")] } },
    { RETRY_BASE_MS: "0" }
  );
  const masterRes = await p.callChat({ messages: [] }, { principal: { isMaster: true, role: "admin" } });
  assert.equal(masterRes.status, 200);
  assert.equal(masterRes.headers.get("X-Gateway-Account"), "t6b", "retry path must stamp attribution for master");
  assert.equal(masterRes.headers.get("X-Gateway-Account-Id"), null, "redundant Account-Id duplicate is gone");
  assert.equal(await masterRes.text(), "recovered");

  // 普通客户端：无任何账号归因头
  globalThis.fetch = async () => new Response("served", { status: 200 });
  const p2 = new WorkBuddyProvider(
    { id: "wb-t6c", config: { accounts: [acc("t6c")] } },
    { RETRY_BASE_MS: "0" }
  );
  const clientRes = await p2.callChat({ messages: [] }, { principal: { isMaster: false, role: "client" } });
  assert.equal(clientRes.status, 200);
  assert.equal(clientRes.headers.get("X-Gateway-Account"), null, "client must not see account id");
  assert.equal(await clientRes.text(), "served");
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
  const res = await p.callChat({ messages: [] }, {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "fast");
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
    async get(key) {
      if (key.includes("obj_acc")) return { expiresAt: future, streak: 1 };
      if (key.includes("str_acc")) return JSON.stringify({ expiresAt: future, streak: 2 });
      return null;
    }
  };
  await hydrateCooldowns({ GATEWAY_KV: mockKv }, [{ id: "obj_acc" }, { id: "str_acc" }], true);
  assert.equal(accountCooldownRecord.get("obj_acc")?.streak, 1);
  assert.equal(accountCooldownRecord.get("str_acc")?.streak, 2);
});

test("affinityKeyForCall prefers session header, falls back to system+tools fingerprint", async () => {
  const { affinityKeyForCall } = await import("../src/providers/workbuddy/index.js");
  const req = (h) => ({ headers: new Headers(h) });
  assert.equal(
    affinityKeyForCall({}, { request: req({ "x-session-id": "abc" }) }),
    "sid:abc"
  );
  const payload = {
    messages: [{ role: "system", content: "You are a coder." }],
    tools: [{ type: "function", function: { name: "bash" } }]
  };
  const k1 = affinityKeyForCall(payload, {});
  assert.ok(k1.startsWith("sig:"), "falls back to stable fingerprint");
  assert.equal(affinityKeyForCall(payload, {}), k1, "same conversation maps to same key");
  assert.equal(affinityKeyForCall({ messages: [] }, {}), null, "no signal falls back to round-robin");
});

test("workbuddy region table: cn and intl endpoints frozen", async () => {
  const { WorkBuddyProvider, normalizeWorkbuddyRegion, resolveWorkbuddyEndpoints } =
    await import("../src/providers/workbuddy/index.js");
  assert.equal(normalizeWorkbuddyRegion(undefined), "cn");
  assert.equal(normalizeWorkbuddyRegion("INTL"), "intl");
  assert.equal(normalizeWorkbuddyRegion("xx"), "cn");
  const cn = resolveWorkbuddyEndpoints("cn");
  assert.ok(cn.chat.includes("copilot.tencent.com"));
  const intl = resolveWorkbuddyEndpoints("intl");
  assert.ok(intl.chat.includes("www.codebuddy.ai"));
  assert.ok(intl.refresh.includes("/plugin/auth/token/refresh"));
  const env = { USER_ID: "u", ACCESS_TOKEN: "a", REFRESH_TOKEN: "r" };
  const cnProv = new WorkBuddyProvider({ id: "workbuddy", config: {} }, env);
  assert.equal(cnProv.getAccounts().length, 1, "cn keeps env fallback");
  const intlProv = new WorkBuddyProvider({ id: "workbuddy-intl", config: { region: "intl" } }, env);
  assert.deepEqual(intlProv.getAccounts(), [], "intl must not reuse cn env credentials");
  assert.equal(intlProv.ep().chat, "https://www.codebuddy.ai/v2/chat/completions");
});

test("explicit pool members fail closed without own credentials (no env borrowing)", async () => {
  const env = { USER_ID: "u", ACCESS_TOKEN: "env-access", REFRESH_TOKEN: "env-refresh" };
  const pool = new WorkBuddyProvider(
    { id: "wb-pool-fc", config: { accounts: [{ id: "bare-1", enabled: true, userId: "u1" }] } },
    env
  );
  const [member] = pool.getAccounts();
  assert.equal(await pool.getActiveToken(member), "", "pool member must not borrow env access token");
  assert.equal(await pool.refreshAccessToken(member), null, "pool member must not borrow env refresh token");
  // 合成单账号保持旧语义：env 兜底可用
  const single = new WorkBuddyProvider({ id: "wb-single-fc", config: {} }, env);
  const [solo] = single.getAccounts();
  assert.equal(solo.allowEnvFallback, true);
  assert.equal(await single.getActiveToken(solo), "env-access", "synthesized single account keeps env fallback");
});

test("getBalance correctly aggregates cyclical packages and trial packages with CycleCapacityRemainPrecise=0", async () => {
  globalThis.fetch = async () => {
    return new Response(JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: "Trial",
                CapacityRemain: 500,
                CapacityRemainPrecise: "500",
                CycleCapacityRemain: 0,
                CycleCapacityRemainPrecise: "0",
                CapacitySize: 500,
                CapacitySizePrecise: "500",
                CycleCapacitySize: 500,
                CycleCapacitySizePrecise: "500"
              },
              {
                PackageName: "CheckIn",
                CapacityRemain: 100,
                CapacityRemainPrecise: "100.00000000",
                CycleCapacityRemain: 100,
                CycleCapacityRemainPrecise: "100.00000000",
                CapacitySize: 100,
                CapacitySizePrecise: "100",
                CycleCapacitySize: 100,
                CycleCapacitySizePrecise: "100"
              }
            ]
          }
        }
      }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const p = new WorkBuddyProvider(
    { id: "wb-test", config: { accounts: [{ id: "acc1", userId: "u1", accessToken: "t1" }] } },
    {}
  );
  const bal = await p.getBalance();
  assert.equal(bal.success, true);
  assert.equal(bal.balance, 600);
  assert.equal(bal.total, 600);
});

// --- JWT 预过期主动静默刷新（Direction 2）单元测试 ---

function makeMockJwt(expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user-1", exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.mock-signature`;
}

test("parseJwtExp parses exp timestamp correctly and tolerates malformed inputs", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const jwt = makeMockJwt(nowSec + 3600);
  assert.equal(parseJwtExp(jwt), nowSec + 3600);

  // 非 JWT 字符串
  assert.equal(parseJwtExp("plain-api-token"), null);
  assert.equal(parseJwtExp(""), null);
  assert.equal(parseJwtExp(null), null);
  assert.equal(parseJwtExp(undefined), null);

  // 格式异常或 payload 损坏
  assert.equal(parseJwtExp("header.invalid_base64!.sig"), null);
  const badPayloadJwt = `header.${Buffer.from("not-json").toString("base64url")}.sig`;
  assert.equal(parseJwtExp(badPayloadJwt), null);

  // 缺失 exp 或 exp 非数值
  const noExpJwt = `header.${Buffer.from(JSON.stringify({ sub: "u" })).toString("base64url")}.sig`;
  assert.equal(parseJwtExp(noExpJwt), null);
  const strExpJwt = `header.${Buffer.from(JSON.stringify({ exp: "12345" })).toString("base64url")}.sig`;
  assert.equal(parseJwtExp(strExpJwt), null);
});

test("isJwtExpiringSoon detects expiring and valid JWTs accurately", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  // 充足有效期（1 小时后过期，缓冲区 300 秒）
  const validToken = makeMockJwt(nowSec + 3600);
  assert.equal(isJwtExpiringSoon(validToken), false);

  // 濒临过期（剩 100 秒，缓冲区 300 秒）
  const expiringToken = makeMockJwt(nowSec + 100);
  assert.equal(isJwtExpiringSoon(expiringToken), true);

  // 已过期（50 秒前过期）
  const expiredToken = makeMockJwt(nowSec - 50);
  assert.equal(isJwtExpiringSoon(expiredToken), true);

  // 非 JWT 凭证返回 false（不破坏普通测试与静态 key）
  assert.equal(isJwtExpiringSoon("non-jwt-token"), false);

  // 自定义 bufferSeconds
  assert.equal(isJwtExpiringSoon(validToken, 7200), true);
  assert.equal(isJwtExpiringSoon(expiringToken, 50), false);
});

test("jwtRefreshBufferSec honors env override with safe fallback", () => {
  assert.equal(jwtRefreshBufferSec(undefined), 300);
  assert.equal(jwtRefreshBufferSec({}), 300);
  assert.equal(jwtRefreshBufferSec({ JWT_REFRESH_BUFFER_SEC: "600" }), 600);
  assert.equal(jwtRefreshBufferSec({ JWT_REFRESH_BUFFER_SEC: "invalid" }), 300);
  assert.equal(jwtRefreshBufferSec({ JWT_REFRESH_BUFFER_SEC: "-50" }), 300);
  assert.equal(jwtRefreshBufferSec({ JWT_REFRESH_BUFFER_SEC: "120.8" }), 120);
});

test("getActiveToken proactively refreshes JWT token expiring soon without hitting 401", async () => {
  resetSchedulingCounterForTests();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiringToken = makeMockJwt(nowSec + 60); // 60s 后过期（在 300s 缓冲期内）
  const freshToken = makeMockJwt(nowSec + 7200);

  let refreshCalls = 0;
  scriptFetch({
    refresh: { code: 0, data: { accessToken: freshToken, refreshToken: "refreshed-rt" } }
  });
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/auth/token/refresh")) refreshCalls += 1;
    return baseFetch(url);
  };

  const account = { id: "proactive-1", userId: "u1", accessToken: expiringToken, refreshToken: "rt-1" };
  const p = new WorkBuddyProvider(
    { id: "wb-proactive", config: { accounts: [account] } },
    {}
  );

  // 首次取 token：探测到 expiringToken 即将过期，主动静默发起刷新
  const token = await p.getActiveToken(account);
  assert.equal(token, freshToken, "getActiveToken must return the fresh proactively refreshed token");
  assert.equal(refreshCalls, 1, "refresh endpoint must be called once proactively");

  // 再次取 token：命中内存缓存中的 freshToken，不再发刷新
  const cachedToken = await p.getActiveToken(account);
  assert.equal(cachedToken, freshToken, "subsequent call must hit memory cache with fresh token");
  assert.equal(refreshCalls, 1, "subsequent getActiveToken call must hit cache without additional refresh");
});

test("getActiveToken gracefully falls back to best effort token if proactive refresh fails", async () => {
  resetSchedulingCounterForTests();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiringToken = makeMockJwt(nowSec + 60);

  // 上游刷新失败（如 500）
  globalThis.fetch = async () => new Response("internal error", { status: 500 });

  const account = { id: "proactive-fail", userId: "u1", accessToken: expiringToken, refreshToken: "rt-1" };
  const p = new WorkBuddyProvider(
    { id: "wb-proactive-fail", config: { accounts: [account] } },
    {}
  );

  const token = await p.getActiveToken(account);
  assert.equal(token, expiringToken, "fallback to best effort available token when proactive refresh fails");
});


