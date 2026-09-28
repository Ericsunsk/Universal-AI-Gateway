import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// C6：守护 CONTEXT.md 声明的 kernel 不变量 —— `src/core/` 不得 import adapters。
// 此前无任何测试守护这条，fleet.js 因此长期越层（已迁至 providers/fleet.js）。
// 本测试是「文档声称的不变量」与「代码实际」之间唯一的机器可验证契约。
const CORE_DIR = join(import.meta.dirname, "..", "src", "core");

// 提取一个模块的**全部**依赖说明符：静态 import / export-from / 动态 import() / require()。
//
// 此前只用 /^\s*import\s[^;]*?from\s+"([^"]+)"/ 抓静态形式，于是
// `await import("../providers/index.js")` 这类动态引入可完全绕过 C6 —— 契约形同虚设。
// 三条分支合并为一次扫描：动态 import()/require() 无 from 关键字，必须单列。
// 值部分排除引号，且不含嵌套量词，无回溯风险。
const DEP_SPEC_RE = /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*(?:import|export)\s[^;]*?\bfrom\s*)["']([^"']+)["']/gm;

function extractDeps(src) {
  return [...src.matchAll(DEP_SPEC_RE)].map(m => m[1]);
}

test("C6: src/core/* must not import from providers/ or exchange/ (kernel purity)", () => {
  const files = readdirSync(CORE_DIR).filter(f => f.endsWith(".js"));
  assert.ok(files.length > 0, "core dir must contain modules");

  const violations = [];
  for (const f of files) {
    const src = readFileSync(join(CORE_DIR, f), "utf8");
    for (const spec of extractDeps(src)) {
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
    for (const spec of extractDeps(src)) {
      const isBarePkg = !spec.startsWith(".") && !spec.startsWith("/");
      if (isBarePkg) continue; // node: 内置与 npm 包放行
      if (!relAllowed.test(spec)) violations.push(`src/core/${f} → ${spec}`);
    }
  }
  assert.deepEqual(violations, [], `unexpected core dependency:\n  ${violations.join("\n  ")}`);
});
