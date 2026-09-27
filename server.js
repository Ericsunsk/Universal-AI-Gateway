import http from "node:http";
import cluster from "node:cluster";
import { setGlobalDispatcher, Agent } from "undici";
import handler from "./api/index.js";
import { log } from "./src/logging/logger.js";

// 配置 Node.js 出站全局连接池：保持到上游的 TCP 长连接 60 秒（覆盖常见人机交互间隔），
// 避免每次请求都重新执行跨国 TCP 三次握手与 TLS 1.3 协商（消除 150~200ms TTFB 延迟）
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60_000,      // 空闲连接保持 60 秒
  keepAliveMaxTimeout: 300_000,  // 最长复用 5 分钟
  connections: 64,               // 连接池大小上限
  pipelining: 1
}));

const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";
const concurrency = Number(process.env.WEB_CONCURRENCY) || 1;

function startServer() {
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
    log.info("Server running", { pid: process.pid, url: `http://${host}:${port}` });
  });

  process.on("SIGTERM", () => {
    log.info("Received SIGTERM, shutting down gracefully", { pid: process.pid });
    server.close(() => {
      process.exit(0);
    });
  });
}

if (cluster.isPrimary && concurrency > 1) {
  log.info("Starting cluster primary", { workers: concurrency });
  for (let i = 0; i < concurrency; i++) {
    cluster.fork();
  }
  cluster.on("exit", (worker, code, signal) => {
    log.warn("Worker exited, restarting", { pid: worker.process.pid, code, signal });
    cluster.fork();
  });
} else {
  startServer();
}
