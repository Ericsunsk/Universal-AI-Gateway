// KV Module —— 网关唯一的持久化 seam。
import { log } from "../logging/logger.js";
//
// Interface（调用方与测试穿越的是同一道 seam）：
//   kv.get(key, type?) -> value | null  —— miss / 过期 / 远端失败一律回 null，永不抛错
//   kv.getWithStatus(key, type?) -> { value, ok } —— 区分“键不存在”(ok=true) 与“远端读失败”(ok=false)
//   kv.put(key, value, opts?) -> void    —— opts.expirationTtl 秒级 TTL；永不抛错
//   kv.delete(key) -> void               —— 永不抛错
//   - key 恒为 string；value 为 string 或可 JSON 序列化对象（写时统一转 string）。
//   - type === "json"（或 { type: "json" }，兼容 CF KV 调用习惯）：读时 JSON.parse，失败回 null。
//   - 一致性：同 isolate 写后即读一致（内存 tier 先行落盘）；跨 isolate 以远端为准；
//     远端不可达时读内存（可能陈旧 —— 调用方按自身 TTL / 401 自愈，不依赖强一致）。
//
// Adapters（seam 后的实现，调用方不可见）：
//   - memory：进程内 LRU + TTL，与远端无关，零延迟。
//   - Upstash REST：带超时（默认 5s，可配），超时/失败即降级，绝不拖住函数时长。
//   - composite：Upstash 主存 + 内存兜底；写双写（内存先行），读主备。
// 装配：入口经 createKvFromEnv(env) 构造一次，经 env 注入 core；core 只见 Interface，
//   永不直引 Adapter。测试用 createMemoryKv() 拿 fresh 实例（与生产单例隔离）。
const MEMORY_KV_MAX_ENTRIES = 1000;
const MEMORY_KV_DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小时（冷却记录自带分钟级 TTL，此处只防陈旧配置）
const DEFAULT_REST_TIMEOUT_MS = 5000; // Upstash 单次往返上限；超时即降级内存，不烧函数时长

function toStoredString(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseJsonSafe(val) {
  if (typeof val !== "string") return val;
  try { return JSON.parse(val); } catch (e) { return null; }
}

function isJsonType(type) {
  return type === "json" || type?.type === "json";
}

function ttlMs(opts) {
  const s = Number(opts?.expirationTtl);
  return Number.isFinite(s) && s > 0 ? Math.ceil(s * 1000) : MEMORY_KV_DEFAULT_TTL_MS;
}

function timeoutSignal(ms) {
  // AbortSignal.timeout 需 Node 18+；老运行时降级为无超时（行为同旧代码）
  return typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
}

// 测试与生产共用的内存 Adapter：每次调用返回 fresh 实例，测试间天然隔离。
export function createMemoryKv() {
  const store = new Map(); // key -> { value: string, expiresAt: number }
  return {
    async get(key, type) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return isJsonType(type) ? parseJsonSafe(entry.value) : entry.value;
    },
    // 内存 adapter 永不发生“远端失败”，故 ok 恒为 true（与契约对齐）。
    async getWithStatus(key, type) {
      const value = await this.get(key, type);
      return { value: value === undefined ? null : value, ok: true };
    },
    async put(key, value, opts) {
      const valStr = toStoredString(value);
      if (!store.has(key) && store.size >= MEMORY_KV_MAX_ENTRIES) {
        // Map 按插入有序，删最旧一条
        store.delete(store.keys().next().value);
      }
      // 重复 put 刷新过期时间并移到队尾，保持 LRU 语义
      store.delete(key);
      store.set(key, { value: valStr, expiresAt: Date.now() + ttlMs(opts) });
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

// 生产内存 tier 单例：同一实例内跨请求共享（内存兜底的跨请求可见性即来自它）。
let sharedMemoryKv = null;
function sharedMemory() {
  if (!sharedMemoryKv) sharedMemoryKv = createMemoryKv();
  return sharedMemoryKv;
}

function restEnv(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || env.REDIS_REST_API_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || env.REDIS_REST_API_TOKEN;
  if (!url || !token) return null;
  const raw = Number(env.KV_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REST_TIMEOUT_MS;
  return { url, token, timeoutMs };
}

// Upstash REST Adapter：调用方只传 fallback（通常是 sharedMemory），超时与失败内聚于此。
export function createUpstashKv({ url, token, timeoutMs = DEFAULT_REST_TIMEOUT_MS, fallback = null } = {}) {
  const memory = fallback || createMemoryKv();
  const restCall = (command) => fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: timeoutSignal(timeoutMs),
  });
  // 内部：真正执行一次读，返回 { value, ok }。ok=false 表示“远端读失败且内存未命中”，
  // 调用方据此区分“键不存在”与“读失败”。
  async function readWithStatus(key) {
    let val;
    let remoteOk;
    try {
      const resp = await restCall(["GET", key]);
      if (resp.ok) {
        const data = await resp.json();
        remoteOk = true;
        val = data.result ?? null;
      } else {
        remoteOk = false;
      }
    } catch (e) {
      remoteOk = false;
      log.error("KV GET failed", { key, error: e?.message || String(e) });
    }
    // 远端未命中/失败时读内存兜底（同 isolate 写后即读一致）
    if (val === null || val === undefined) {
      const memVal = await memory.get(key);
      if (memVal !== null && memVal !== undefined) return { value: memVal, ok: true };
      // 内存也没有：远端失败 → ok=false；远端成功但确实无此键 → ok=true
      return { value: null, ok: remoteOk === true };
    }
    return { value: val, ok: true };
  }

  return {
    async get(key, type) {
      const { value } = await readWithStatus(key);
      if (value === null || value === undefined) return null;
      return isJsonType(type) ? parseJsonSafe(value) : value;
    },
    // 显式读状态：{ value, ok }。ok=false 仅当“远端读失败且内存兜底未命中”。
    // 供对“miss 与故障”敏感的场景（配置、冷却记录）区分二者，避免把瞬时抖动当删除。
    async getWithStatus(key, type) {
      const { value, ok } = await readWithStatus(key);
      if (value === null || value === undefined) return { value: null, ok };
      return { value: isJsonType(type) ? parseJsonSafe(value) : value, ok };
    },
    async put(key, value, opts) {
      // 内存先行：同 isolate 写后即读一致，不受远端延迟影响
      await memory.put(key, value, opts);
      try {
        const valStr = toStoredString(value);
        // honoring 调用方传入的秒级 TTL（此前被静默丢弃，冷却落盘即其一）
        const ttlS = Number(opts?.expirationTtl);
        const command = Number.isFinite(ttlS) && ttlS > 0
          ? ["SET", key, valStr, "EX", Math.ceil(ttlS)]
          : ["SET", key, valStr];
        await restCall(command);
      } catch (e) {
        log.error("KV PUT failed", { key, error: e?.message || String(e) });
      }
    },
    async delete(key) {
      await memory.delete(key);
      try {
        await restCall(["DEL", key]);
      } catch (e) {
        log.error("KV DEL failed", { key, error: e?.message || String(e) });
      }
    },
  };
}

// 入口装配唯一工厂：有远端凭证即 composite，无则纯内存（行为与旧 createKvAdapter 一致）。
export function createKvFromEnv(env = {}) {
  const rest = restEnv(env);
  if (!rest) return createMemoryKv();
  return createUpstashKv({ ...rest, fallback: sharedMemory() });
}
