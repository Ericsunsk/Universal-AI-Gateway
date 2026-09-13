export const VERSION = "2.4.0";

let cachedConfig = null;
let cachedConfigTimestamp = 0;
const CONFIG_CACHE_TTL_MS = 60 * 1000; // 60 秒内存热缓存，彻底消除每请求访问 KV 的网络往返开销

export function requireSecret(env, name) {
  const value = env?.[name] || (typeof process !== "undefined" ? process.env?.[name] : undefined);
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Missing required secret "${name}". Refusing to fall back to a hardcoded default — ` +
      `set it in .dev.vars (local), wrangler secret put (Workers), or the platform env (Vercel/Node).`
    );
  }
  return value.trim();
}

export function getDefaultConfig(env) {
  // 拒绝硬编码兜底：缺失即抛错，避免默认主密钥等于公开字面量
  const defaultApiKey = requireSecret(env, "API_KEY");
  const masterKey = env.MASTER_KEY ? requireSecret(env, "MASTER_KEY") : defaultApiKey;

  return {
    master_key: masterKey,
    cron_secret: env.CRON_SECRET || "",
    max_context_turns: env.MAX_CONTEXT_TURNS !== undefined ? parseInt(env.MAX_CONTEXT_TURNS, 10) : (typeof process !== "undefined" && (process.env?.VERCEL || process.env?.NODE_ENV) ? 0 : 40),
    usage_provider_id: "workbuddy",
    providers: [
      {
        id: "workbuddy",
        name: "WorkBuddy (腾讯云代码助手)",
        type: "workbuddy",
        enabled: true,
        config: {
          userId: env.USER_ID || "",
          accessToken: env.ACCESS_TOKEN || "",
          refreshToken: env.REFRESH_TOKEN || ""
        }
      },
      {
        id: "opencode",
        name: "OpenCode Zen (Free Tier)",
        type: "opencode",
        enabled: true,
        config: {
          baseUrl: "https://opencode.ai/zen/v1"
        }
      },
      {
        id: "openrouter",
        name: "OpenRouter (备用)",
        type: "openai",
        enabled: false,
        config: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "",
          defaultHeaders: {
            "HTTP-Referer": "https://worker-gateway.local",
            "X-Title": "Worker Gateway"
          }
        }
      }
    ],
    routes: {
      "deepseek-v4.1-flash": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "openrouter", model: "deepseek/deepseek-chat" }
      ],
      "deepseek-v4-flash": [
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" }
      ],
      "deepseek-v4-pro": [
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "openrouter", model: "deepseek/deepseek-r1" }
      ],
      "claude-3-7-sonnet-20250219": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "openrouter", model: "anthropic/claude-3.7-sonnet" }
      ],
      "claude-3-5-sonnet-20241022": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" }
      ],
      "claude-3-5-haiku-20241022": [
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" }
      ],
      "claude-3-haiku-20240307": [
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "claude-3-opus-20240229": [
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "openrouter", model: "anthropic/claude-3-opus" }
      ],
      "glm-5.2": [
        { provider: "workbuddy", model: "glm-5.2" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "kimi-k3-1": [
        { provider: "workbuddy", model: "kimi-k3-1" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "mimo-v2.5-free": [
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "ling-3.0-flash-fin-free": [
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "big-pickle": [
        { provider: "opencode", model: "big-pickle" }
      ],
      "nemotron-3-ultra-free": [
        { provider: "opencode", model: "nemotron-3-ultra-free" }
      ]
    },
    virtual_keys: {
      [defaultApiKey]: {
        name: "Default Client Key (CC-Switch / Claude Code)",
        enabled: true,
        models: ["*"],
        role: "client"
      }
    }
  };
}

export async function getConfig(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && (now - cachedConfigTimestamp < CONFIG_CACHE_TTL_MS)) {
    return cachedConfig;
  }

  const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
  if (kv) {
    try {
      const raw = await kv.get("GATEWAY_CONFIG");
      if (raw) {
        const parsed = JSON.parse(raw);
        cachedConfig = parsed;
        cachedConfigTimestamp = now;
        return parsed;
      }
    } catch (e) {
      console.error("Failed to read GATEWAY_CONFIG from KV:", e);
    }
  }

  // 初始配置：从默认模板生成并初次写入 KV
  const initialConfig = getDefaultConfig(env);
  if (kv) {
    try {
      await kv.put("GATEWAY_CONFIG", JSON.stringify(initialConfig, null, 2));
    } catch (e) {}
  }

  cachedConfig = initialConfig;
  cachedConfigTimestamp = now;
  return initialConfig;
}

// 敏感字段清单：这些值永不通过 API 返回给客户端
const SECRET_FIELDS = ["accessToken", "refreshToken", "apiKey", "cookie", "token", "jwtToken"];
const REDACTED = "***REDACTED***";

function isRedacted(value) {
  return value === REDACTED || value === "" || value === null || value === undefined;
}

// 遍历 providers 集合，兼容数组与对象两种形态
function eachProvider(providers, fn) {
  if (!providers) return;
  if (Array.isArray(providers)) providers.forEach(fn);
  else if (typeof providers === "object") Object.values(providers).forEach(fn);
}

// 递归脱敏任意对象树上的机密字段
function redactNode(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach(redactNode);
    return;
  }
  for (const field of SECRET_FIELDS) {
    if (node[field] !== undefined && node[field] !== "") node[field] = REDACTED;
  }
  // provider.config 与多账号 accounts 均可能内嵌机密，递归处理
  for (const key of ["config", "accounts", "account"]) {
    if (node[key]) redactNode(node[key]);
  }
}

// virtual_keys 的真实密钥是「对象键名」而非值，直接返回会泄露。
// 读取时只回显键名指纹（前 6 位 + 长度），不回显完整密钥。
export function maskKeyName(key) {
  if (typeof key !== "string" || key.length <= 6) return REDACTED;
  return `${key.slice(0, 6)}…（已隐藏，共 ${key.length} 位）`;
}

function redactVirtualKeys(virtualKeys) {
  if (!virtualKeys || typeof virtualKeys !== "object") return;
  const entries = Object.entries(virtualKeys);
  for (const [key] of entries) {
    virtualKeys[maskKeyName(key)] = virtualKeys[key];
    delete virtualKeys[key];
  }
}

// 递归遍历 providers 树，对机密字段做脱敏，返回可安全序列化给客户端的副本
export function redactConfig(config) {
  if (!config || typeof config !== "object") return config;
  const clone = JSON.parse(JSON.stringify(config));

  eachProvider(clone.providers, redactNode);
  redactVirtualKeys(clone.virtual_keys);
  // 顶层机密一并清除
  for (const field of SECRET_FIELDS) delete clone[field];
  delete clone.cron_secret;
  delete clone.master_key;
  return clone;
}

// 递归回填机密：目标中脱敏/缺失的机密字段沿用来源值
function mergeNode(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  if (Array.isArray(target)) {
    target.forEach((item, i) => mergeNode(item, Array.isArray(source) ? source[i] : undefined));
    return;
  }
  for (const field of SECRET_FIELDS) {
    if (isRedacted(target[field]) && !isRedacted(source[field])) {
      target[field] = source[field];
    }
  }
  // provider.config / accounts 均需递归回填
  for (const key of ["config", "account"]) {
    if (target[key]) mergeNode(target[key], source[key]);
  }
  if (Array.isArray(target.accounts)) mergeNode(target.accounts, source.accounts);
}

// 合并式写入的机密回填：新配置中脱敏/缺失的机密字段沿用旧值
function mergeSecrets(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return incoming;
  const merged = JSON.parse(JSON.stringify(incoming));
  const oldProviders = existing?.providers;

  // 按 provider.id 建立旧值索引，兼容数组与对象两种形态
  const oldById = {};
  eachProvider(oldProviders, (p) => { if (p?.id) oldById[p.id] = p; });

  eachProvider(merged.providers, (provider) => {
    const source = provider?.id ? oldById[provider.id] : undefined;
    if (source) mergeNode(provider, source);
  });

  // 顶层机密（cron_secret / 任何 SECRET_FIELDS）同样回填
  for (const field of [...SECRET_FIELDS, "cron_secret", "master_key"]) {
    if (isRedacted(merged[field]) && existing?.[field] !== undefined) {
      merged[field] = existing[field];
    }
  }

  // virtual_keys 的真实密钥是键名：客户端回传的是掩码占位名，
  // 若原样落库会把密钥「改名」成掩码，导致鉴权全部失效。此处按位序回填原名。
  if (merged.virtual_keys && typeof merged.virtual_keys === "object" && existing?.virtual_keys) {
    const oldKeys = Object.keys(existing.virtual_keys);
    const newKeys = Object.keys(merged.virtual_keys);
    const isMasked = k => k.includes("…") || k === REDACTED;
    const allMasked = newKeys.length === oldKeys.length && newKeys.every(isMasked);
    if (allMasked) {
      const restored = {};
      newKeys.forEach((maskedKey, i) => { restored[oldKeys[i]] = merged.virtual_keys[maskedKey]; });
      merged.virtual_keys = restored;
    }
  }

  return merged;
}

// 配置 schema 校验：在写入边界拦截畸形配置，避免请求期才报 502。
// 返回错误消息数组；空数组表示通过。
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return ["config must be an object"];
  }
  if (!Array.isArray(config.providers) && !(config.providers && typeof config.providers === "object")) {
    errors.push("providers must be an array or object");
  }
  if (!config.routes || typeof config.routes !== "object") {
    errors.push("routes must be an object mapping model name -> route array");
  } else {
    for (const [model, routeList] of Object.entries(config.routes)) {
      if (!Array.isArray(routeList) || routeList.length === 0) {
        errors.push(`routes["${model}"] must be a non-empty array`);
        continue;
      }
      routeList.forEach((r, i) => {
        if (!r || typeof r !== "object") {
          errors.push(`routes["${model}"][${i}] must be an object`);
        } else if (!r.provider || typeof r.provider !== "string") {
          errors.push(`routes["${model}"][${i}] missing string "provider"`);
        }
      });
    }
  }
  return errors;
}

async function readRawConfig(env) {
  const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
  if (!kv) return null;
  try {
    const raw = await kv.get("GATEWAY_CONFIG");
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("Failed to read GATEWAY_CONFIG from KV:", e);
    return null;
  }
}

export async function saveConfig(env, newConfig) {
  const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
  if (!kv) {
    throw new Error("KV Namespace GATEWAY_KV is not bound");
  }
  // 合并式写入：客户端省略或传回脱敏占位符的机密字段，保留 KV 中的原值，
  // 避免一次配置 POST 静默抹掉所有凭据。
  const existing = await readRawConfig(env);
  const merged = mergeSecrets(existing, newConfig);
  // 写入前校验，拦截畸形配置
  const validationErrors = validateConfig(merged);
  if (validationErrors.length > 0) {
    throw new Error("Invalid config: " + validationErrors.join("; "));
  }
  await kv.put("GATEWAY_CONFIG", JSON.stringify(merged, null, 2));
  // 立即热同步当前 Isolate 内存缓存
  cachedConfig = merged;
  cachedConfigTimestamp = Date.now();
  return true;
}
