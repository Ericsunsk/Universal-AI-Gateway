// 门面（compatibility facade）—— exchange 领域的**公开接口**。
//
// exchange 领域内部已按接缝拆分为三个真实模块：
//   - transform.js —— 请求侧转译（Anthropic ⇄ OpenAI）
//   - stream.js    —— 响应侧转译（SSE / JSON）
//   - dispatch.js  —— 路由与故障转移
//
// 本文件**只做重导出**，不承载任何逻辑：它是领域的稳定入口，让
// src/index.js、scripts/bench.mjs 与测试只依赖一个路径，而不是内部三分。
// 这是 deletion test 的刻意例外——删掉它，复杂度只会“移动”到各 import 语句，
// 不会“集中”到别处；因此它保留，但被冻结为纯门面。
//
// 约定（由 test/exchange-facade.test.js 守卫）：
//   本文件只允许出现 `export ... from "..."` 形式的语句。
//   任何函数、常量、副作用、条件判断都不得写入此处——逻辑属于三个真实模块。
export * from "./transform.js";
export * from "./stream.js";
export * from "./dispatch.js";
