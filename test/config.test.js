import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// refreshConfig 有进程级模块缓存：ok=false 且“无缓存”的分支只能在全新的模块状态里验证。
// 因此这三条状态回归用例各自跑在独立子进程（fresh module graph），天然确定性、互不串扰。
const dir = path.dirname(fileURLToPath(import.meta.url));

function runScenario(body) {
  // 子进程的日志走 stderr（setLogSink），stdout 只留测试自身的 JSON：
  // 否则 config 模块的结构化日志会污染 JSON.parse。
  const script = `
import { setLogSink } from ${JSON.stringify(path.join(dir, "../src/logging/logger.js"))};
setLogSink((line) => process.stderr.write(line + "\\n"));
import { getConfig } from ${JSON.stringify(path.join(dir, "../src/config/config.js"))};
${body}
`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
}

test("refreshConfig uses parsed KV config when getWithStatus ok=true and does not write", () => {
  const out = runScenario(`
const stored = { config_version: 99, master_key: "sk-kv", providers: [], routes: {} };
let puts = 0;
const env = { API_KEY: "sk-test", MASTER_KEY: "sk-master", CRON_SECRET: "cs-test",
  GATEWAY_KV: { getWithStatus: async () => ({ value: JSON.stringify(stored), ok: true }),
    get: async () => JSON.stringify(stored), put: async () => { puts++; } } };
const cfg = await getConfig(env, true);
console.log(JSON.stringify({ version: cfg.config_version, master: cfg.master_key, puts }));
`);
  assert.equal(out.version, 99, "must use the stored config");
  assert.equal(out.master, "sk-kv");
  assert.equal(out.puts, 0, "no KV write on a successful read");
});

test("refreshConfig on remote read failure (ok=false, no cache) returns defaults and never writes KV", () => {
  const out = runScenario(`
let puts = 0;
const env = { API_KEY: "sk-test", MASTER_KEY: "sk-master", CRON_SECRET: "cs-test",
  GATEWAY_KV: { getWithStatus: async () => ({ value: null, ok: false }),
    get: async () => null, put: async () => { puts++; } } };
const cfg = await getConfig(env, true);
console.log(JSON.stringify({ master: cfg.master_key, puts }));
`);
  assert.equal(out.master, "sk-master", "falls back to defaults");
  assert.equal(out.puts, 0, "remote failure must NOT clobber KV");
});

test("refreshConfig writes initial config on a genuine first run (ok=true, value=null)", () => {
  const out = runScenario(`
let puts = 0;
const env = { API_KEY: "sk-test", MASTER_KEY: "sk-master", CRON_SECRET: "cs-test",
  GATEWAY_KV: { getWithStatus: async () => ({ value: null, ok: true }),
    get: async () => null, put: async () => { puts++; } } };
const cfg = await getConfig(env, true);
console.log(JSON.stringify({ master: cfg.master_key, puts }));
`);
  assert.equal(out.master, "sk-master", "generates defaults");
  assert.equal(out.puts, 1, "genuine first run writes initial config once");
});

test("refreshConfig falls back to legacy kv.get when getWithStatus is absent", () => {
  const out = runScenario(`
const stored = { config_version: 7, providers: [], routes: {} };
let puts = 0;
const env = { API_KEY: "sk-test", MASTER_KEY: "sk-master", CRON_SECRET: "cs-test",
  GATEWAY_KV: { get: async () => JSON.stringify(stored), put: async () => { puts++; } } };
const cfg = await getConfig(env, true);
console.log(JSON.stringify({ version: cfg.config_version, puts }));
`);
  assert.equal(out.version, 7);
  assert.equal(out.puts, 0);
});

// 反例（review 发现）：getWithStatus 抛错（而非返回 ok=false）时，readOk 若仍为 true
// 会落到初始配置写入分支，用默认模板 clobber 远端真实配置。此用例锁死该回归。
test("refreshConfig never writes when getWithStatus rejects", () => {
  const out = runScenario(`
let puts = 0;
const env = { API_KEY: "sk-test", MASTER_KEY: "sk-master", CRON_SECRET: "cs-test",
  GATEWAY_KV: { getWithStatus: async () => { throw new Error("boom"); },
    get: async () => null, put: async () => { puts++; } } };
const cfg = await getConfig(env, true);
console.log(JSON.stringify({ master: cfg.master_key, puts }));
`);
  assert.equal(out.master, "sk-master", "falls back to defaults");
  assert.equal(out.puts, 0, "a rejected read must NOT be treated as a first run");
});
