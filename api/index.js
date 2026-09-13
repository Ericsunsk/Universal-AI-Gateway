import { Readable } from "node:stream";
import worker from "../src/index.js";

export const config = {
  maxDuration: 300, // 允许最大 300 秒执行时长（适配长时间思考模型与深度代码审计）
};

// 内存级 KV 降级缓存（当未绑定 Upstash / Vercel KV 时在容器生命周期内持久）
const memoryKvStorage = new Map();

function createKvAdapter(env) {
  const restUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_API_URL;
  const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_API_TOKEN;

  if (restUrl && restToken) {
    return {
      async get(key) {
        try {
          // 优先使用标准 POST 命令数组，彻底规避 key 中的特殊字符与 URL 编码截断问题
          const resp = await fetch(restUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${restToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(["GET", key]),
          });
          if (!resp.ok) return memoryKvStorage.get(key) || null;
          const data = await resp.json();
          return data.result ?? (memoryKvStorage.get(key) || null);
        } catch (e) {
          console.error(`[Upstash KV] GET ${key} failed:`, e);
          return memoryKvStorage.get(key) || null;
        }
      },
      async put(key, value) {
        const valStr = typeof value === "string" ? value : JSON.stringify(value);
        memoryKvStorage.set(key, valStr);
        try {
          await fetch(restUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${restToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(["SET", key, valStr]),
          });
        } catch (e) {
          console.error(`[Upstash KV] PUT ${key} failed:`, e);
        }
      },
    };
  }

  // 默认内存存储
  return {
    async get(key) {
      return memoryKvStorage.get(key) || null;
    },
    async put(key, value) {
      memoryKvStorage.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

// 网关只读取白名单内的环境变量/密钥，其余进程环境变量不可达
// 防止意外泄露或读取未声明的机密字段
const ENV_ALLOWLIST = new Set([
  "API_KEY", "MASTER_KEY", "CRON_SECRET",
  "USER_ID", "ACCESS_TOKEN", "REFRESH_TOKEN",
  "MAX_CONTEXT_TURNS",
  "GATEWAY_KV", "WORKBUDDY_KV",
  "KV_REST_API_URL", "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "REDIS_REST_API_URL", "REDIS_REST_API_TOKEN",
  "OPENCODE_PROXY_URLS", "PROXY_URL",
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
  const kv = createKvAdapter(env);
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

// Web / Node 双入口共享的请求上下文：白名单 env + KV 适配 + waitUntil
function makeRequestContext() {
  const env = getEnvContext();
  const ctx = {
    waitUntil: (p) => {
      p?.catch?.((err) => console.error("[Vercel waitUntil error]", err));
    },
  };
  return { env, ctx };
}

async function handleWebRequest(request) {
  const { env, ctx } = makeRequestContext();
  return await worker.fetch(request, env, ctx);
}

async function handleNodeRequest(req, res) {
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
    });

    const { env, ctx } = makeRequestContext();

    const webResponse = await worker.fetch(webRequest, env, ctx);

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
