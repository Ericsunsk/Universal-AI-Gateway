import http from "node:http";
import handler from "./api/index.js";
import { log } from "./src/logging/logger.js";

const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";

const server = http.createServer((req, res) => {
  const start = Date.now();
  // 只记 pathname，**绝不记 query**：/checkin?secret=xxx 的 cron 凭据走 query
  // （见 src/index.js 的 /checkin 路由），req.url 会把 secret 原样带进日志聚合平台。
  const pathname = (() => {
    try { return new URL(req.url, "http://localhost").pathname; }
    catch { return "(unparseable)"; }
  })();
  res.once("close", () => {
    const duration_ms = Date.now() - start;
    if (res.writableEnded) {
      log.info("HTTP Request", {
        method: req.method,
        path: pathname,
        status: res.statusCode,
        duration_ms
      });
    } else {
      log.warn("HTTP Request Closed Prematurely", {
        method: req.method,
        path: pathname,
        status: res.statusCode || 499,
        duration_ms,
        aborted: req.destroyed
      });
    }
  });
  handler(req, res);
});

// Render 及反向代理（Envoy / Cloudflare）长连接保活与超时配置：
// Node 默认 keepAliveTimeout 为 5s，而反向代理空闲复用连接时间为 60s~100s。
// 若不显式调高，代理在 5s~60s 复用已断连接时会遭遇 TCP 竞态导致 ECONNRESET 或 502 Bad Gateway。
server.keepAliveTimeout = 120 * 1000; // 120 秒（大于代理端的 100 秒）
server.headersTimeout = 125 * 1000;   // 125 秒（必须大于 keepAliveTimeout）
server.requestTimeout = 300 * 1000;   // 300 秒（与 api/index.js maxDuration 保持一致）

server.listen(port, host, () => {
  log.info("Server running", { url: `http://${host}:${port}` });
});

process.on("SIGTERM", () => {
  log.info("Received SIGTERM, shutting down gracefully");
  server.close(() => {
    process.exit(0);
  });
});
