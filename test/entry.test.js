import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ENV_ALLOWLIST } from "../api/index.js";

// 入口 allowlist 覆盖率：src/ 与 api/ 消费的每个 env 键必须出现在白名单里，
// 否则生产环境（getEnvContext 只复制白名单键）读到 undefined，旋钮静默失效。
// 前车：KV_TIMEOUT_MS、INTL_* 曾漏网。
function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("every env key consumed by src/api is allowlisted", () => {
  const roots = [
    new URL("../src", import.meta.url),
    new URL("../api/index.js", import.meta.url),
  ];
  const files = [];
  for (const r of roots) {
    const p = new URL(r.pathname, import.meta.url).pathname;
    files.push(...(fs.statSync(p).isDirectory() ? collectFiles(p) : [p]));
  }
  const patterns = [
    /(?:env|process\.env)\?\.\s*([A-Z][A-Z0-9_]*)/g, // env?.X / process.env?.X
    /(?<![A-Za-z_$.])(?:env|process\.env)\.([A-Z][A-Z0-9_]*)/g, // env.X（大写开头，排除 .env.local 这类字符串残留）
    /requireSecret\(\s*env\s*,\s*"([^"]+)"\)/g, // requireSecret(env, "API_KEY")
    /readEnv\("([^"]+)"\)/g, // readEnv("INTL_USER_ID")
  ];
  const missing = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!ENV_ALLOWLIST.has(m[1])) missing.add(`${m[1]} (${path.basename(file)})`);
      }
    }
  }
  assert.deepEqual([...missing].sort(), [], "allowlist must cover every consumed env key");
});
