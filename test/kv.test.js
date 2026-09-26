import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryKv, createUpstashKv, createKvFromEnv } from "../src/kv/index.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// 脚本化 Upstash REST：按命令队列应答，记录实际发出的命令
function scriptUpstash({ get = {}, putOk = true, hang = false } = {}) {
  const commands = [];
  globalThis.fetch = async (_url, { body, signal } = {}) => {
    void _url;
    const cmd = JSON.parse(body);
    commands.push(cmd);
    if (hang) {
      // ref'd 定时器让 loop 存活（AbortSignal.timeout 内部 timer 是 unref 的，
      // 纯 pending mock 下 loop 会提前排空导致用例被 cancel）；abort 50ms 必先赢。
      await new Promise((_resolve, rej) => {
        const t = setTimeout(() => rej(new Error("mock: remote hung past budget")), 5000);
        const onAbort = () => { clearTimeout(t); rej(signal.reason || new Error("aborted")); };
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    if (cmd[0] === "GET") {
      const v = Object.hasOwn(get, cmd[1]) ? get[cmd[1]] : null;
      return new Response(JSON.stringify({ result: v }), { status: 200 });
    }
    if (!putOk) return new Response("err", { status: 500 });
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  };
  return commands;
}

test("memory adapter roundtrips strings, objects, json and delete", async () => {
  const kv = createMemoryKv();
  await kv.put("s", "v");
  assert.equal(await kv.get("s"), "v");
  await kv.put("o", { a: 1 });
  assert.equal(await kv.get("o"), '{"a":1}');
  assert.deepEqual(await kv.get("o", "json"), { a: 1 });
  assert.deepEqual(await kv.get("o", { type: "json" }), { a: 1 });
  assert.equal(await kv.get("missing"), null);
  await kv.put("bad", "{oops");
  assert.equal(await kv.get("bad", "json"), null);
  await kv.delete("s");
  assert.equal(await kv.get("s"), null);
});

test("memory instances are isolated per factory call", async () => {
  const a = createMemoryKv();
  const b = createMemoryKv();
  await a.put("k", "1");
  assert.equal(await b.get("k"), null);
});

test("upstash adapter reads remote, falls back to memory on failure", async () => {
  scriptUpstash({ get: { hit: "remote-v" } });
  const mem = createMemoryKv();
  await mem.put("fb", "mem-v");
  const kv = createUpstashKv({ url: "https://x", token: "t", fallback: mem });
  assert.equal(await kv.get("hit"), "remote-v");
  assert.equal(await kv.get("miss"), null);
  assert.equal(await kv.get("fb"), "mem-v", "remote miss falls back to memory (write may have landed only locally)");
  // 远端 500 → 读内存兜底
  scriptUpstash({ get: {}, putOk: false });
  const kv2 = createUpstashKv({ url: "https://x", token: "t", fallback: mem });
  assert.equal(await kv2.get("fb"), "mem-v");
});

test("upstash put honors expirationTtl via SET EX", async () => {
  const commands = scriptUpstash({});
  const kv = createUpstashKv({ url: "https://x", token: "t", fallback: createMemoryKv() });
  await kv.put("ttl", "v", { expirationTtl: 90 });
  assert.deepEqual(commands[0], ["SET", "ttl", "v", "EX", 90]);
  await kv.put("plain", "v");
  assert.deepEqual(commands[1], ["SET", "plain", "v"]);
  // 内存 tier 同步 honoring TTL：写后即读一致
  assert.equal(await kv.get("ttl"), "v");
});

test("upstash get degrades to memory within timeout budget", async () => {
  scriptUpstash({ hang: true });
  const mem = createMemoryKv();
  await mem.put("k", "mem-v");
  const kv = createUpstashKv({ url: "https://x", token: "t", timeoutMs: 50, fallback: mem });
  const t0 = Date.now();
  assert.equal(await kv.get("k"), "mem-v");
  assert.ok(Date.now() - t0 < 2000, "hung remote must not burn function duration");
});

test("createKvFromEnv selects memory without credentials, composite with them", async () => {
  globalThis.fetch = async () => { throw new Error("must not call network without credentials"); };
  const mem = createKvFromEnv({});
  await mem.put("k", "v");
  assert.equal(await mem.get("k"), "v");

  const commands = scriptUpstash({ get: { k: "remote" } });
  const comp = createKvFromEnv({ UPSTASH_REDIS_REST_URL: "https://x", UPSTASH_REDIS_REST_TOKEN: "t" });
  assert.equal(await comp.get("k"), "remote");
  assert.deepEqual(commands[0], ["GET", "k"]);
});

// ---- H2：getWithStatus 区分“键不存在”与“远端读失败” ----
test("getWithStatus: remote miss vs remote failure are distinguishable", async () => {
  // 远端成功但无此键 → ok=true, value=null（真 miss）
  scriptUpstash({ get: {} });
  const kv = createUpstashKv({ url: "https://x", token: "t", fallback: createMemoryKv() });
  assert.deepEqual(await kv.getWithStatus("absent"), { value: null, ok: true });

  // 远端抛错且内存无兜底 → ok=false（读失败，不等于删除）
  globalThis.fetch = async () => { throw new Error("network dead"); };
  const kv2 = createUpstashKv({ url: "https://x", token: "t", fallback: createMemoryKv() });
  assert.deepEqual(await kv2.getWithStatus("absent"), { value: null, ok: false });
  // 传统 get 行为保持不变（兼容）
  assert.equal(await kv2.get("absent"), null);
});

test("getWithStatus: memory fallback hit is ok=true even when remote failed", async () => {
  globalThis.fetch = async () => { throw new Error("network dead"); };
  const mem = createMemoryKv();
  await mem.put("cfg", "v1");
  const kv = createUpstashKv({ url: "https://x", token: "t", fallback: mem });
  assert.deepEqual(await kv.getWithStatus("cfg"), { value: "v1", ok: true });
});

test("memory adapter exposes getWithStatus with ok=true", async () => {
  const kv = createMemoryKv();
  await kv.put("j", { a: 1 });
  assert.deepEqual(await kv.getWithStatus("j", "json"), { value: { a: 1 }, ok: true });
  assert.deepEqual(await kv.getWithStatus("missing"), { value: null, ok: true });
});

test("empty string is a value, not a miss (null only on miss/expire/failure)", async () => {
  const kv = createMemoryKv();
  await kv.put("e", "");
  assert.equal(await kv.get("e"), "", "stored empty must roundtrip, not coerce to null");
  assert.deepEqual(await kv.getWithStatus("e"), { value: "", ok: true });
  scriptUpstash({ get: { e: "" } });
  const kv2 = createUpstashKv({ url: "https://x", token: "t", fallback: createMemoryKv() });
  assert.equal(await kv2.get("e"), "");
  assert.deepEqual(await kv2.getWithStatus("e"), { value: "", ok: true });
});
