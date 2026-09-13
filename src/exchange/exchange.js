// 门面：exchange 领域已按接缝拆分为 transform.js（请求侧转译）/ stream.js（响应侧转译）/
// dispatch.js（路由与故障转移）。为保持既有导入路径（src/index.js、各测试）零改动，这里只做重导出。
export * from "./transform.js";
export * from "./stream.js";
export * from "./dispatch.js";
