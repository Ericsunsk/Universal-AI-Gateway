import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Candidate 03 守卫：exchange.js 被冻结为**纯门面**（compatibility facade）。
// 理由（deletion test）：删掉它，复杂度只会“移动”到各 import 语句，不会“集中”；
// 故保留这个稳定入口，但禁止它长出任何逻辑——逻辑属于 transform/stream/dispatch。
// 本测试是活的约束：一旦有人往门面里塞函数/常量/副作用，立刻失败。

const here = path.dirname(fileURLToPath(import.meta.url));
const facadePath = path.join(here, "../src/exchange/exchange.js");

function meaningfulStatements(source) {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
}

test("exchange.js facade contains ONLY pure re-exports", () => {
  const source = fs.readFileSync(facadePath, "utf8");
  const statements = meaningfulStatements(source);
  assert.ok(statements.length > 0, "facade must re-export something");
  for (const stmt of statements) {
    assert.match(
      stmt,
      /^export\s+\*\s+from\s+["'][^"']+["'];?$/,
      `facade may only contain pure re-exports, found: ${stmt}`
    );
  }
});

test("exchange.js facade re-exports exactly the three domain modules", () => {
  const source = fs.readFileSync(facadePath, "utf8");
  const specifiers = [...source.matchAll(/from\s+["'](\.\/[^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(
    specifiers.sort(),
    ["./dispatch.js", "./stream.js", "./transform.js"],
    "facade re-export set must stay pinned"
  );
});

test("exchange.js facade still resolves the domain's public surface", async () => {
  const mod = await import("../src/exchange/exchange.js");
  // 三个真实模块各自的代表作都能经门面取到（防止误删某个 export * 行）。
  assert.equal(typeof mod.dispatchExchange, "function", "dispatch surface");
  assert.equal(typeof mod.transformAnthropicToOpenAI, "function", "transform surface");
  assert.equal(typeof mod.formatOpenAIToAnthropicJson, "function", "stream surface");
});
