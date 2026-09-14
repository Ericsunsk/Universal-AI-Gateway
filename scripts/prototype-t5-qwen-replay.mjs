// PROTOTYPE (throwaway, T5) — qwen live 样本回放，验证 translator 映射。
// 跑法：node scripts/prototype-t5-qwen-replay.mjs
// 规则：只读 fixture + 当下 parser，不写回任何东西；结论落 issue #6， validated 映射进主分支代码。
// 状态面：逐事件打印 kind + 文本头，末尾给 verdict。
import fs from "node:fs";
import { parseQwenSSEObject } from "../src/providers/qwenweb/protocol.js";

const raw = fs.readFileSync("test/fixtures/qwen-sse-answer.txt", "utf8");
const lines = raw.split("\n").filter(l => l.trim().startsWith("data:"));
let reasoning = "", content = "", done = false, unknown = 0;
for (const line of lines) {
  const text = line.trim().slice(5).trim();
  if (!text || text === "[DONE]") continue;
  let obj = null;
  try { obj = JSON.parse(text); } catch { unknown++; continue; }
  const ev = parseQwenSSEObject(obj);
  if (ev.kind === "reasoning") reasoning += ev.text || "";
  else if (ev.kind === "content") content += ev.text || "";
  else if (ev.kind === "done") done = true;
  else if (ev.kind !== "usage") unknown++;
  console.log(ev.kind.padEnd(10), "|", JSON.stringify((ev.text || "").slice(0, 50)));
}
console.log("---");
console.log("reasoning chars:", reasoning.length, "| content:", JSON.stringify(content.slice(0, 60)), "| done:", done, "| unknown:", unknown);
const ok = reasoning.length > 0 && content.includes("144") && done && unknown === 0;
console.log(ok ? "VERDICT: PASS" : "VERDICT: FAIL");
process.exit(ok ? 0 : 1);
