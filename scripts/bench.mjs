// Bench harness —— 热路径基线与回归对照（可重复资产，非一次性脚本）。
// 纯本地 node + 内存 mock，不碰网络与平台 CLI，保证基线稳定。
//   npm run bench                  全场景
//   npm run bench -- --only=a      只要 SSE 首字节
//   npm run bench -- --only=b      只要故障转移（含 KV 计数）
//   npm run bench -- --only=c      只要持续吞吐
//   npm run bench -- --only=d      只要 502-jitter 故障转移
//   RETRY_BASE_MS=50 npm run bench -- --only=b   对照睡眠旋钮效果
// 用法：改动前后各跑一遍，对 P50/P99 与 KV ops。
import { performance } from "node:perf_hooks";
import { dispatchExchange } from "../src/exchange/exchange.js";
import { createProvider } from "../src/providers/index.js";

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("="))
);
const ONLY = args.only || "abc";
const ITERS = Number(args.iters) || 0;

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / s.length;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2) };
}

// 带计数器的内存 KV：量化 Q1c（KV 成本），行为与内存降级一致
function countingKv() {
  const store = new Map();
  const ops = { get: 0, put: 0, delete: 0 };
  return {
    ops,
    async get(k) { ops.get++; return store.get(k) ?? null; },
    async put(k, v) { ops.put++; store.set(k, v); },
    async delete(k) { ops.delete++; store.delete(k); },
  };
}

const sseStream = (chunks) => new ReadableStream({
  async start(c) {
    const enc = new TextEncoder();
    for (const ch of chunks) {
      await new Promise(r => setImmediate(r));
      c.enqueue(enc.encode(ch));
    }
    c.close();
  }
});

const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
  'data: [DONE]\n\n',
];

// ---- 场景 A：Anthropic 流式首字节（transform + dispatch + SSE 转译全链路） ----
async function scenarioA(n) {
  const fleet = {
    getProvider: () => ({
      type: "openai",
      callChat: async () => new Response(sseStream(CHAT_SSE), {
        status: 200, headers: { "Content-Type": "text/event-stream" }
      })
    })
  };
  const config = { routes: { m: [{ provider: "p", model: "m" }] } };
  const body = () => ({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] });
  // warmup：完整消费
  for (let i = 0; i < 5; i++) {
    const r = await dispatchExchange({ protocol: "anthropic", model: "m", body: body(), fleet, config, request: new Request("http://x/") });
    await r.text();
  }
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const res = await dispatchExchange({ protocol: "anthropic", model: "m", body: body(), fleet, config, request: new Request("http://x/") });
    const reader = res.body.getReader();
    await reader.read(); // 首个 block（含 message_start）
    const ttfb = performance.now() - t0;
    // 读完剩余流再释放：中途 cancel 会让转译协程卡在 writer 背压上（已知泄漏，见 stream.js），
    // bench 必须走完整消费路径才干净。
    while (!(await reader.read()).done) {}
    reader.releaseLock();
    samples.push(ttfb);
  }
  return stats(samples);
}

// ---- 场景 B：workbuddy 真实 failover（429 → 下一账号）+ KV 计数 ----
async function scenarioB(n, { failStatus = 429 } = {}) {
  const times = [];
  const kvTotals = { get: 0, put: 0, delete: 0 };
  for (let i = 0; i < n + 2; i++) {
    const kv = countingKv();
    const tag = `b${i}`;
    const p = createProvider(
      { id: `wbb-${tag}`, type: "workbuddy", config: { accounts: [{ id: `${tag}a`, userId: "u", accessToken: "t" }, { id: `${tag}b`, userId: "u", accessToken: "t" }] } },
      { GATEWAY_KV: kv, ...(process.env.RETRY_BASE_MS ? { RETRY_BASE_MS: process.env.RETRY_BASE_MS } : {}) }
    );
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("limited", { status: failStatus });
      return new Response(sseStream(CHAT_SSE), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    try {
      const t0 = performance.now();
      const res = await p.callChat({ stream: true, messages: [{ role: "user", content: "hi" }] }, {});
      await res.text();
      const dt = performance.now() - t0;
      if (i >= 2) {
        times.push(dt);
        kvTotals.get += kv.ops.get; kvTotals.put += kv.ops.put; kvTotals.delete += kv.ops.delete;
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  return { ...stats(times), kvPerCall: Object.fromEntries(Object.entries(kvTotals).map(([k, v]) => [k, +(v / times.length).toFixed(2)])) };
}

// ---- 场景 C：OpenAI 直通持续吞吐（dispatch 开销下限） ----
async function scenarioC(n) {
  const fleet = {
    getProvider: () => ({
      type: "openai",
      callChat: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200, headers: { "Content-Type": "application/json" }
      })
    })
  };
  const config = { routes: { m: [{ provider: "p", model: "m" }] } };
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const res = await dispatchExchange({
      protocol: "openai", model: "m",
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      fleet, config, request: new Request("http://x/")
    });
    await res.text();
  }
  const secs = (performance.now() - t0) / 1000;
  return { rps: Math.round(n / secs) };
}

const N = (d) => ITERS || d;
if (ONLY.includes("a")) console.log("A sse-first-byte ms:", JSON.stringify(await scenarioA(N(50))));
if (ONLY.includes("b")) console.log("B failover-429 ms + kv/call:", JSON.stringify(await scenarioB(N(30))));
// 502 抖动路径：默认睡 600ms；RETRY_BASE_MS=0 对照（Q6 旋钮证据）
if (ONLY.includes("d")) console.log("D failover-502-jitter ms:", JSON.stringify(await scenarioB(N(10), { failStatus: 502 })));
if (ONLY.includes("c")) console.log("C passthrough:", JSON.stringify(await scenarioC(N(200))));
