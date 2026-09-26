// Agent probe —— 面向 opencode / Claude Code 的线上 SSE 冒烟探针。
// 打真实部署地址，跑编码 agent 典型场景，把协议字段原样 dump 并断言：
//   - tool_use 流式增量（input_json_delta）
//   - thinking block 的 signature（多轮回传是否可被上游续接）
//   - usage 的 cache_read / cache_creation / input_tokens
//   - stop_reason ∈ {end_turn, tool_use, max_tokens, stop_sequence}
//   - 长重复前缀下的前缀缓存命中（coding agent 的第一成本杠杆）
// 只读探针：不写生产代码、不改配置；凭证走环境变量，绝不打印明文。
//
import { performance } from "node:perf_hooks";

// 用法：
//   GATEWAY_URL=https://your-app.vercel.app GATEWAY_KEY=sk-xxx \
//     node scripts/probe-agent.mjs
//   node scripts/probe-agent.mjs --model=claude-sonnet-4-20250514   # 指定模型
//   node scripts/probe-agent.mjs --proto=openai                      # 走 /v1/chat/completions
//   node scripts/probe-agent.mjs --only=sse                          # 只跑流式 tool_use 场景
//   DEBUG_DUMP=1 node scripts/probe-agent.mjs                        # 额外逐事件打印原始 SSE
//
// 环境变量：
//   GATEWAY_URL   部署根地址（必填，形如 https://xxx.vercel.app）
//   GATEWAY_KEY   客户端 API_KEY（必填，绝不回显）
//   PROBE_MODEL   模型名（可选，默认 claude-sonnet-4-20250514）
//   DEBUG_DUMP=1  逐事件打印原始 SSE 行（默认只打印报告）

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.replace(/^--/, "").split("="))
);
const ONLY = args.only || "sse,tools,thinking,cache";
const PROTO = args.proto || process.env.PROBE_PROTO || "anthropic";
const MODEL = args.model || process.env.PROBE_MODEL || "claude-sonnet-4-20250514";
const DUMP = process.env.DEBUG_DUMP === "1";

const BASE = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
const KEY = process.env.GATEWAY_KEY || "";

if (!BASE || !KEY) {
  console.error("缺少 GATEWAY_URL 或 GATEWAY_KEY。用法见文件头注释。");
  process.exit(2);
}

const PATHS = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
};

// 单次请求的 SSE 采集结果（协议无关的汇聚结构）
async function callGateway({ path, body, signal }) {
  const url = BASE + path;
  const headers = { "Content-Type": "application/json" };
  if (PROTO === "anthropic") {
    headers["x-api-key"] = KEY;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = "Bearer " + KEY;
  }

  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const httpStatus = res.status;
  const ctype = res.headers.get("content-type") || "";

  const events = [];       // 解析后的 SSE data 对象（anthropic 形）
  const rawLines = [];     // 原始行，供 DEBUG_DUMP
  let ttfb = null;
  let textOut = "";
  let stopReason = null;
  let usage = {};
  let sawThinking = false;
  let thinkingHasSignature = false;
  let toolCalls = [];      // { id, name, json, closed }
  let openBlockType = null;
  let acc = { thinking: "", text: "", toolJson: "" };

  if (ctype.includes("text/event-stream") && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = Math.round(performance.now() - t0);
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (DUMP) rawLines.push(line);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        events.push(evt);
        consume(evt, acc, (patch) => {
          if (patch.sawThinking) sawThinking = true;
          if (patch.thinkingHasSignature) thinkingHasSignature = true;
          if (patch.textOut) textOut += patch.textOut;
          if (patch.stopReason) stopReason = patch.stopReason;
          if (patch.usage) usage = { ...usage, ...patch.usage };
          if (patch.toolStart) toolCalls.push({ id: patch.toolStart.id, name: patch.toolStart.name, json: "", closed: false });
          if (patch.toolDelta) {
            const last = toolCalls[toolCalls.length - 1];
            if (last) last.json += patch.toolDelta;
          }
          if (patch.toolStop && toolCalls.length) toolCalls[toolCalls.length - 1].closed = true;
        });
        openBlockType = evt.type || openBlockType;
      }
    }
  } else {
    // 非流式 JSON，归一化到同一结构
    const json = await res.json().catch(() => ({}));
    events.push(json);
    consumeNonStream(json, acc, (patch) => {
      if (patch.textOut) textOut += patch.textOut;
      if (patch.stopReason) stopReason = patch.stopReason;
      if (patch.usage) usage = { ...usage, ...patch.usage };
      if (patch.sawThinking) sawThinking = true;
      if (patch.thinkingHasSignature) thinkingHasSignature = true;
      if (patch.toolStart) toolCalls.push({ id: patch.toolStart.id, name: patch.toolStart.name, json: patch.toolStart.json || "", closed: true });
    });
    ttfb = Math.round(performance.now() - t0);
  }

  const totalMs = Math.round(performance.now() - t0);
  if (DUMP && rawLines.length) {
    console.error("  --- raw SSE ---");
    for (const l of rawLines) console.error("  " + l);
    console.error("  --- /raw SSE ---");
  }
  return { httpStatus, ctype, ttfb, totalMs, stopReason, usage, textOut, sawThinking, thinkingHasSignature, toolCalls, rawLines, events };
}

// Anthropic SSE 事件 → 汇聚结构（与 stream.js 输出形状对齐）
function consume(evt, emit) {
  switch (evt.type) {
    case "message_start": {
      const u = evt.message?.usage || {};
      if (u && Object.keys(u).length) emit({ usage: u });
      break;
    }
    case "content_block_start": {
      const b = evt.content_block || {};
      if (b.type === "thinking") emit({ sawThinking: true });
      if (b.type === "tool_use") emit({ toolStart: { id: b.id, name: b.name } });
      break;
    }
    case "content_block_delta": {
      const d = evt.delta || {};
      if (d.type === "text_delta") emit({ textOut: d.text || "" });
      if (d.type === "thinking_delta") emit({ sawThinking: true });
      if (d.type === "signature_delta") emit({ thinkingHasSignature: true });
      if (d.type === "input_json_delta") emit({ toolDelta: d.partial_json || "" });
      break;
    }
    case "content_block_stop": {
      emit({ toolStop: true });
      break;
    }
    case "message_delta": {
      if (evt.delta?.stop_reason) emit({ stopReason: evt.delta.stop_reason });
      if (evt.usage) emit({ usage: evt.usage });
      break;
    }
    default: break;
  }
}

// OpenAI 形 JSON → 汇聚结构
function consumeNonStream(json, acc, emit) {
  emit({ usage: json.usage || {} });
  const msg = json.choices?.[0]?.message || {};
  const finish = json.choices?.[0]?.finish_reason;
  if (finish) emit({ stopReason: finish });
  if (msg.content) emit({ textOut: msg.content });
  if (msg.reasoning_content) { emit({ sawThinking: true }); acc.thinking += msg.reasoning_content; }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      emit({ toolStart: { id: tc.id, name: tc.function?.name, json: tc.function?.arguments || "" } });
    }
  }
}

// ---- 断言与报告 ----
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? "  — " + detail : ""}`);
}

function reportUsage(usage = {}) {
  const keys = [
    "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens",
    "prompt_tokens_details", "cached_tokens",
  ];
  const shown = {};
  for (const k of keys) if (usage[k] !== undefined) shown[k] = usage[k];
  return shown;
}

// ---- 场景 1：流式 tool_use（编码 agent 的命脉） ----
async function scenarioSseTools() {
  console.log("\n== 场景 1：流式 tool_use ==");
  const body = {
    model: MODEL,
    max_tokens: 512,
    stream: true,
    tools: [{
      name: "read_file",
      description: "Read a file from disk",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
    messages: [{ role: "user", content: "Use the read_file tool to read package.json. Call the tool, do not explain." }],
  };
  const r = await callGateway({ path: PATHS[PROTO], body });
  console.log(`  http=${r.httpStatus} ttfb=${r.ttfb}ms total=${r.totalMs}ms stop_reason=${r.stopReason}`);
  console.log("  usage:", JSON.stringify(reportUsage(r.usage)));
  check("HTTP 200", r.httpStatus === 200, `got ${r.httpStatus}`);
  check("收到 tool_use", r.toolCalls.length > 0, `${r.toolCalls.length} call(s)`);
  if (r.toolCalls.length) {
    const tc = r.toolCalls[0];
    let parsed = null, parseOk = false;
    try { parsed = JSON.parse(tc.json); parseOk = true; } catch {}
    check("tool_use 有 id 与 name", !!tc.id && !!tc.name, `id=${tc.id} name=${tc.name}`);
    check("tool arguments 是合法 JSON", parseOk, parseOk ? JSON.stringify(parsed) : `raw="${tc.json.slice(0, 80)}"`);
    check("tool 参数含 path", parseOk && parsed && "path" in parsed);
  }
  check("stop_reason = tool_use", r.stopReason === "tool_use" || r.stopReason === "tool_calls", `got ${r.stopReason}`);
  return r;
}

// ---- 场景 2：thinking + signature 跨轮回传 ----
async function scenarioThinking() {
  console.log("\n== 场景 2：thinking block 与 signature ==");
  const body = {
    model: MODEL,
    max_tokens: 512,
    stream: true,
    thinking: { type: "enabled", budget_tokens: 1024 },
    messages: [{ role: "user", content: "What is 17 * 23? Think step by step." }],
  };
  const r = await callGateway({ path: PATHS[PROTO], body });
  console.log(`  http=${r.httpStatus} ttfb=${r.ttfb}ms stop_reason=${r.stopReason}`);
  console.log("  usage:", JSON.stringify(reportUsage(r.usage)));
  check("HTTP 200", r.httpStatus === 200, `got ${r.httpStatus}`);
  if (r.sawThinking) {
    check("thinking 带 signature（多轮可回传）", r.thinkingHasSignature,
      r.thinkingHasSignature ? "" : "无 signature_delta：opencode 下一轮回传 thinking 可能被上游 400");
  } else {
    console.log("  [SKIP] 上游未返回 thinking（该模型/store 可能不支持 extended thinking）");
  }
  return r;
}

// ---- 场景 3：长重复前缀 → 前缀缓存命中 ----
async function scenarioCache() {
  console.log("\n== 场景 3：前缀缓存命中（长重复上下文） ==");
  // 造一段稳定的大前缀（模拟 repo 上下文），两次请求前缀完全一致，只变尾部问题。
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(400); // ~4.5k tokens 量级
  const stablePrefix = [
    { role: "user", content: "You are a coding assistant. Here is the repository context:\n" + filler },
    { role: "assistant", content: "Understood. I have the repository context." },
  ];
  const mk = (q) => ({
    model: MODEL, max_tokens: 64, stream: true,
    messages: [...stablePrefix, { role: "user", content: q }],
  });
  const first = await callGateway({ path: PATHS[PROTO], body: mk("Reply with the single word: one") });
  const second = await callGateway({ path: PATHS[PROTO], body: mk("Reply with the single word: two") });
  console.log("  first  usage:", JSON.stringify(reportUsage(first.usage)));
  console.log("  second usage:", JSON.stringify(reportUsage(second.usage)));
  const cacheRead = second.usage.cache_read_input_tokens ?? second.usage.prompt_tokens_details?.cached_tokens ?? 0;
  // 上游根本不返回任何 cache 字段时，无法从本链路观测缓存命中，属能力限制而非网关缺陷，SKIP。
  const cacheObservable =
    second.usage.cache_read_input_tokens !== undefined ||
    second.usage.cache_creation_input_tokens !== undefined ||
    second.usage.prompt_tokens_details !== undefined;
  if (!cacheObservable) {
    console.log("  [SKIP] 上游未返回任何 cache 字段（该 store 不支持前缀缓存观测）");
  } else {
    check("第二次请求命中前缀缓存", cacheRead > 0,
      cacheRead > 0 ? `${cacheRead} cached tokens` : "cache_read=0：前缀缓存未命中，长任务每轮全价重算");
    if (second.usage.cache_creation_input_tokens !== undefined) {
      console.log(`  [INFO] cache_creation_input_tokens = ${second.usage.cache_creation_input_tokens}`);
    }
  }
  return { first, second };
}

// ---- 场景 4：usage / stop_reason 完整性（合并到上面已覆盖，此处做总结断言） ----
function summarize() {
  console.log("\n== 汇总 ==");
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed}/${results.length} 断言通过`);
  const fails = results.filter(r => !r.ok);
  if (fails.length) {
    console.log("  失败项：");
    for (const f of fails) console.log(`    - ${f.name}${f.detail ? "  (" + f.detail + ")" : ""}`);
  }
}

async function main() {
  console.log(`Agent Probe → ${BASE}${PATHS[PROTO]}  model=${MODEL}  proto=${PROTO}`);
  if (ONLY.includes("tools") || ONLY.includes("sse")) await scenarioSseTools();
  if (ONLY.includes("thinking")) await scenarioThinking();
  if (ONLY.includes("cache")) await scenarioCache();
  if (DUMP) console.log("\n(DEBUG_DUMP 已开启：原始 SSE 行已在各场景请求中回显到 stderr)");
  summarize(results);
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}

main().catch(err => {
  console.error("探针异常终止：", err?.message || err);
  process.exit(1);
});
