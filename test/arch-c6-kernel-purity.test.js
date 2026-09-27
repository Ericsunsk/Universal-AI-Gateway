import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// C6：守护 CONTEXT.md 声明的 kernel 不变量 —— `src/core/` 不得 import adapters。
// 此前无任何测试守护这条，fleet.js 因此长期越层（已迁至 providers/fleet.js）。
// 本测试是「文档声称的不变量」与「代码实际」之间唯一的机器可验证契约。
const CORE_DIR = join(import.meta.dirname, "..", "src", "core");

test("C6: src/core/* must not import from providers/ or exchange/ (kernel purity)", () => {
  const files = readdirSync(CORE_DIR).filter(f => f.endsWith(".js"));
  assert.ok(files.length > 0, "core dir must contain modules");

  const violations = [];
  for (const f of files) {
    const src = readFileSync(join(CORE_DIR, f), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map(m => m[1]);
    for (const spec of imports) {
      if (/(^|\/)providers(\/|$)/.test(spec) || /(^|\/)exchange(\/|$)/.test(spec)) {
        violations.push(`src/core/${f} → ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `kernel purity violated:\n  ${violations.join("\n  ")}`);
});

test("C6: src/core/* may only import within core/ or the leaf layers (logging, http, kv, config)", () => {
  // 相对路径限定在 leaf 层；裸模块（npm 包，如 gpt-tokenizer）与 node: 内置放行。
  const relAllowed = /^\.\.?\/(logging|http|kv|config)\/|^\.\/[a-zA-Z]/;
  const files = readdirSync(CORE_DIR).filter(f => f.endsWith(".js"));
  const violations = [];
  for (const f of files) {
    const src = readFileSync(join(CORE_DIR, f), "utf8");
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)) {
      const spec = m[1];
      const isBarePkg = !spec.startsWith(".") && !spec.startsWith("/");
      if (isBarePkg) continue; // node: 内置与 npm 包放行
      if (!relAllowed.test(spec)) violations.push(`src/core/${f} → ${spec}`);
    }
  }
  assert.deepEqual(violations, [], `unexpected core dependency:\n  ${violations.join("\n  ")}`);
});
