import { Readable } from "node:stream";
import worker from "../src/index.js";

export const config = {
  maxDuration: 60, // 允许最大 60 秒执行时长（Vercel Hobby 免费上限）
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

function getEnvContext() {
  const env = { ...process.env };
  const kv = createKvAdapter(env);
  env.GATEWAY_KV = kv;
  env.WORKBUDDY_KV = kv;
  return env;
}

function resolveUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";

  // Vercel 重写时，若 req.url 为 /api，优先从 x-matched-path 或 x-invoke-path 读取实际路径
  let path = req.url || "/";
  if ((path === "/api" || path === "/api/" || path.startsWith("/api?")) && req.headers["x-matched-path"]) {
    path = req.headers["x-matched-path"];
  }
  return new URL(path, `${protocol}://${host}`);
}

async function handleWebRequest(request) {
  const env = getEnvContext();
  const ctx = {
    waitUntil: (p) => {
      p?.catch?.((err) => console.error("[Vercel waitUntil error]", err));
    },
  };
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

    const env = getEnvContext();
    const ctx = {
      waitUntil: (p) => {
        p?.catch?.((err) => console.error("[Vercel waitUntil error]", err));
      },
    };

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
