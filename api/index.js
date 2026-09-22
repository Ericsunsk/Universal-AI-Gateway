import { Readable } from "node:stream";
import worker from "../src/index.js";
import { createKvFromEnv } from "../src/kv/index.js";

export const config = {
  maxDuration: 300, // 允许最大 300 秒执行时长（适配长时间思考模型与深度代码审计）
};

// 网关只读取白名单内的环境变量/密钥，其余进程环境变量不可达
// （导出供测试锁定覆盖率：src/ 与 api/ 消费的每个 env 键必须在此出现，见 test/entry.test.js）。
// 防止意外泄露或读取未声明的机密字段
export const ENV_ALLOWLIST = new Set([
  "API_KEY", "MASTER_KEY", "CRON_SECRET",
  "USER_ID", "ACCESS_TOKEN", "REFRESH_TOKEN",
  "MAX_CONTEXT_TURNS", "RETRY_BASE_MS",
  "GATEWAY_KV", "WORKBUDDY_KV",
  "KV_REST_API_URL", "KV_REST_API_TOKEN",
  "KV_TIMEOUT_MS",
  "INTL_USER_ID", "INTL_ACCESS_TOKEN", "INTL_REFRESH_TOKEN",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "REDIS_REST_API_URL", "REDIS_REST_API_TOKEN",
  "PROXY_URL",
  "VERCEL", "NODE_ENV", "VERCEL_URL", "VERCEL_PROJECT_DOMAINS",
  "PORT",
]);

function getEnvContext() {
  // 只复制白名单内的环境变量，不泄露未声明的机密
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  // KV 经唯一的持久化 seam 装配（src/kv）：有远端凭证即 Upstash 主存 + 内存兜底，
  // 无则纯内存；调用方只见 get/put/delete，与 Adapter 无关。
  const kv = createKvFromEnv(env);
  env.GATEWAY_KV = kv;
  env.WORKBUDDY_KV = kv;
  return env;
}

// 白名单域名（生产环境由 VERCEL_URL / VERCEL_PROJECT_DOMAINS 注入，本地开发回退到 localhost）
// 进程内缓存：环境变量运行时不变，每请求重建 Set + JSON.parse 是无谓开销
let cachedTrustedHosts = null;
let cachedTrustedHostsKey = "";
function getTrustedHosts() {
  const key = `${process.env.VERCEL_URL || ""}\n${process.env.VERCEL_PROJECT_DOMAINS || ""}`;
  if (cachedTrustedHosts && cachedTrustedHostsKey === key) return cachedTrustedHosts;
  const hosts = new Set();
  if (process.env.VERCEL_URL) {
    hosts.add(process.env.VERCEL_URL.replace(/^https?:\/\//, ""));
  }
  if (process.env.VERCEL_PROJECT_DOMAINS) {
    try {
      const domains = JSON.parse(process.env.VERCEL_PROJECT_DOMAINS);
      domains.forEach(d => hosts.add(d));
    } catch (e) {}
  }
  hosts.add("localhost");
  hosts.add("127.0.0.1");
  cachedTrustedHosts = hosts;
  cachedTrustedHostsKey = key;
  return hosts;
}

function resolveUrl(req) {
  const trustedHosts = getTrustedHosts();
  const actualHost = req.headers.host || "localhost";

  // 安全：x-forwarded-host 只有在等于实际 host 或白名单域名时才被信任，否则忽略，防止伪造
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = (forwardedHost && trustedHosts.has(forwardedHost)) ? forwardedHost : actualHost;

  // 安全：x-forwarded-proto 只接受 http/https，其余回退 https，防止头部伪造降级
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = (forwardedProto && (forwardedProto === "https" || forwardedProto === "http")) ? forwardedProto : "https";

  // Vercel 重写时，若 req.url 为 /api，优先从 x-matched-path 读取实际路径
  // 仅在 host 头与白名单匹配时才信任 x-matched-path，防止路径伪造
  let path = req.url || "/";
  if ((path === "/api" || path === "/api/" || path.startsWith("/api?")) && req.headers["x-matched-path"] && trustedHosts.has(actualHost)) {
    path = req.headers["x-matched-path"];
  }
  return new URL(path, `${protocol}://${host}`);
}

// Web / Node 双入口共享的请求上下文：白名单 env + KV 适配。
// 注意：无 waitUntil —— Serverless 下响应结束后台即可能冻结，所有 KV 写必须在请求内 await。
function makeRequestContext() {
  const env = getEnvContext();
  return { env };
}

async function handleWebRequest(request) {
  const { env } = makeRequestContext();
  return await worker.fetch(request, env);
}

async function handleNodeRequest(req, res) {
  // Node 原生请求没有 abort 语义：res 关闭即视为客户端断开，级联中止转译。
  // res 'close' 在正常结束时也会触发，此时 signal 已无在途消费者，中止无副作用。
  const nodeAbort = new AbortController();
  res.once("close", () => nodeAbort.abort());
  try {
    const url = resolveUrl(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
    }

    let body = undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const webRequest = new Request(url.toString(), {
      method: req.method,
      headers: headers,
      body: body,
      duplex: "half",
      // 客户端断开（ res close ）→ 中止网关内转译协程与上游读取，
      // 否则每次“停止生成”都泄漏一个保活定时器 + 卡死的流协程。
      signal: nodeAbort.signal,
    });

    const { env } = makeRequestContext();

    const webResponse = await worker.fetch(webRequest, env);

    const resHeaders = {};
    for (const [k, v] of webResponse.headers.entries()) {
      resHeaders[k] = v;
    }
    // 强制中间代理与边缘 CDN 禁用缓冲，确保 SSE 首字即发
    resHeaders["x-accel-buffering"] = "no";
    if (resHeaders["content-type"]?.includes("text/event-stream")) {
      resHeaders["cache-control"] = "no-cache, no-transform";
    }
    res.writeHead(webResponse.status, resHeaders);
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    if (!webResponse.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(webResponse.body);
    nodeStream.on("data", () => {
      if (typeof res.flush === "function") {
        res.flush();
      }
    });
    nodeStream.on("error", (err) => {
      console.error("[Vercel Stream Pipe Error]", err);
      res.destroy(err);
    });
    nodeStream.pipe(res);
  } catch (err) {
    console.error("[Vercel Gateway Error]", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message || "Internal Server Error" } }));
    } else {
      res.end();
    }
  }
}

export default async function handler(req, res) {
  if (!res || typeof res.writeHead !== "function") {
    return await handleWebRequest(req);
  }
  return await handleNodeRequest(req, res);
}
