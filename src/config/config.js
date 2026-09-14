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
  // 国际站凭证同样走 secrets（与 CN 的 USER_ID 三件套同模式）；缺失即保持 disabled
  const readEnv = (name) => env?.[name] || (typeof process !== "undefined" ? process.env?.[name] : undefined);
  const intlUserId = readEnv("INTL_USER_ID") || "";

  return {
    config_version: 1,
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
        // 国际站：有 INTL_* 环境凭证即启用（与 CN 共用同一套 adapter，按 region 切端点）。
        // 凭证走 secrets（wrangler secret / Vercel env），永不进代码库；无凭证时保持 disabled，零运行时影响。
        // 已验证 serve：glm-5.2。模型池见 CLI product.json：
        // gpt-5.6-sol/terra/luna、gpt-5.5/5.4、gpt-5.3-codex、gemini-3.5-flash、glm-5.3/5.2、kimi-k3/k2.6、minimax-m3。
        id: "workbuddy-intl",
        name: "WorkBuddy Intl (codebuddy.ai)",
        type: "workbuddy",
        enabled: intlUserId !== "",
        config: {
          region: "intl",
          accounts: intlUserId !== "" ? [{
            id: "intl-1",
            name: "intl primary",
            enabled: true,
            userId: intlUserId,
            accessToken: readEnv("INTL_ACCESS_TOKEN") || "",
            refreshToken: readEnv("INTL_REFRESH_TOKEN") || ""
          }] : []
        }
      },
      {
        // Qwen 网页版槽位：默认关闭。启用需填 cookie + 指纹（浏览器登录态抄录，见 qwenweb/fingerprint.js），
        // routes 等 adapter 经真账号 live 验证后再配。验证码/风控由 provider 判 429 进网关冷却。
        id: "qwenweb",
        name: "Qwen Web (chat.qwen.ai)",
        type: "qwenweb",
        enabled: false,
        config: {
          baseUrl: "https://chat.qwen.ai",
          token: "",
          cookie: "",
          fingerprint: {}
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
        { provider: "opencode", model: "big-pickle" },
        { provider: "openrouter", model: "deepseek/deepseek-chat" }
      ],
      "deepseek-v4-flash": [
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "deepseek-v4-pro": [
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" },
        { provider: "openrouter", model: "deepseek/deepseek-r1" }
      ],
      "claude-3-7-sonnet-20250219": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" },
        { provider: "openrouter", model: "anthropic/claude-3.7-sonnet" }
      ],
      "claude-3-5-sonnet-20241022": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" },
        { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" }
      ],
      "claude-3-5-haiku-20241022": [
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "claude-3-haiku-20240307": [
        { provider: "workbuddy", model: "deepseek-v4-flash" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" }
      ],
      "claude-3-opus-20240229": [
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "openrouter", model: "anthropic/claude-3-opus" }
      ],
      "glm-5.2": [
        { provider: "workbuddy", model: "glm-5.2" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "kimi-k3-1": [
        { provider: "workbuddy", model: "kimi-k3-1" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "mimo-v2.5-free": [
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" }
      ],
      // 国际站已验证 serve 的路由（glm-5.2 实测 200）。intl provider 无凭证时保持 disabled，
      // 存量 KV 因回填约束（引用 provider 必须存在）自动跳过本条，不影响现网。
      "glm-5.2-intl": [
        { provider: "workbuddy-intl", model: "glm-5.2" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "ling-3.0-flash-fin-free": [
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "big-pickle" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "big-pickle": [
        { provider: "opencode", model: "big-pickle" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "mimo-v2.5-free" }
      ],
      "nemotron-3-ultra-free": [
        { provider: "opencode", model: "nemotron-3-ultra-free" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "nemotron-3.5-lightning-free": [
        { provider: "opencode", model: "nemotron-3.5-lightning-free" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "muse-spark-1.3": [
        { provider: "opencode", model: "muse-spark-1.3-contributor-free" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "muse-spark-1.3-contributor-free": [
        { provider: "opencode", model: "muse-spark-1.3-contributor-free" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "muse-spark-1.2-contributor-free": [
        { provider: "opencode", model: "muse-spark-1.2-contributor-free" },
        { provider: "opencode", model: "mimo-v2.5-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" }
      ],
      "deepseek-v4-flash-free": [
        { provider: "opencode", model: "deepseek-v4-flash-free" },
        { provider: "opencode", model: "ling-3.0-flash-fin-free" },
        { provider: "opencode", model: "mimo-v2.5-free" }
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

// 纯函数：用代码默认路由回填 KV 存量配置里缺失的路由（只增不改）。
// 背景：KV 一旦写入就盖住代码默认，后续发版新增路由（如 nemotron-3.5）对存量环境不可见，
// 必须手动清 KV 才能生效。本函数让读路径自动补齐缺失项，各环境无需动线上密钥。
// 约束：只补“引用 provider 在存量配置里全部存在”的路由；空 provider 配置（如测试的降级场景）保持原样。
export function backfillMissingRoutes(stored, defaults) {
  if (!stored || typeof stored !== "object" || !defaults || typeof defaults !== "object") return stored;
  const storedRoutes = stored.routes;
  const defaultRoutes = defaults.routes;
  if (!storedRoutes || typeof storedRoutes !== "object" || Array.isArray(storedRoutes)) return stored;
  if (!defaultRoutes || typeof defaultRoutes !== "object" || Array.isArray(defaultRoutes)) return stored;
  const providerIds = new Set();
  eachProvider(stored.providers, (p) => { if (p?.id) providerIds.add(p.id); });
  let added = 0;
  for (const [model, routeList] of Object.entries(defaultRoutes)) {
    if (storedRoutes[model] !== undefined) continue;
    if (!Array.isArray(routeList) || routeList.length === 0) continue;
    if (!routeList.every((r) => r && typeof r.provider === "string" && providerIds.has(r.provider))) continue;
    storedRoutes[model] = JSON.parse(JSON.stringify(routeList));
    added++;
  }
  if (added > 0) console.log(`[Config] Backfilled ${added} missing route(s) from code defaults`);
  return stored;
}

// 在途刷新去重（singleflight）：缓存过期瞬间的突发只触发一次 KV 读，
// 其余并发等待同一 promise。forceRefresh 同样并入，避免测试与管理端并发刷新时重复打 KV。
let inflightConfigRefresh = null;

export async function getConfig(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedConfig && (now - cachedConfigTimestamp < CONFIG_CACHE_TTL_MS)) {
    return cachedConfig;
  }
  if (!inflightConfigRefresh) {
    inflightConfigRefresh = refreshConfig(env).finally(() => { inflightConfigRefresh = null; });
  }
  return inflightConfigRefresh;
}

async function refreshConfig(env) {
  const now = Date.now();
  const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
  if (kv) {
    try {
      const raw = await kv.get("GATEWAY_CONFIG");
      if (raw) {
        const parsed = JSON.parse(raw);
        // 存量 KV 可能落后于代码默认路由：内存中回填缺失项（不写 KV，无版本冲突）。
        try {
          backfillMissingRoutes(parsed, getDefaultConfig(env));
        } catch (e) {}
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

// 掩码键判定 —— 与 maskKeyName 配对，restoreVirtualKeys 共用。
// 短密钥掩码后就是 REDACTED 本身，长密钥含 "…" 指纹，两者都算掩码。
function isMaskedKeyName(key) {
  return key === REDACTED || (typeof key === "string" && key.includes("…"));
}

// virtual_keys 回填：客户端回传的是掩码占位名，若原样落库会把密钥「改名」成掩码，
// 导致鉴权全部失效。此处按位序恢复原名 —— 与 redactVirtualKeys 构成 round-trip，
// 两半的顺序/掩码约定只活在这里，调用方不再各自手写 includes("…") 探测。
function restoreVirtualKeys(mergedKeys, existingKeys) {
  if (!mergedKeys || typeof mergedKeys !== "object" || !existingKeys) return mergedKeys;
  const oldKeys = Object.keys(existingKeys);
  const newKeys = Object.keys(mergedKeys);
  const allMasked = newKeys.length === oldKeys.length && newKeys.every(isMaskedKeyName);
  if (!allMasked) return mergedKeys;
  const restored = {};
  newKeys.forEach((maskedKey, i) => { restored[oldKeys[i]] = mergedKeys[maskedKey]; });
  return restored;
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
// 注意：调用方只传对象（provider / config / account），数组由下面的 accounts id 匹配专管，
// 这里不处理数组形态——不要加通用下标回填，那会把轮换后的账号凭据错位。
function mergeNode(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") return;
  if (Array.isArray(target) || Array.isArray(source)) return;
  for (const field of SECRET_FIELDS) {
    if (isRedacted(target[field]) && !isRedacted(source[field])) {
      target[field] = source[field];
    }
  }
  // provider.config / accounts 均需递归回填
  for (const key of ["config", "account"]) {
    if (target[key]) mergeNode(target[key], source[key]);
  }
  // accounts 按 account.id 语义匹配回填，而不是数组下标
  if (Array.isArray(target.accounts) && Array.isArray(source.accounts)) {
    const sourceById = new Map();
    for (const acc of source.accounts) {
      if (acc?.id) sourceById.set(acc.id, acc);
    }
    for (const targetAcc of target.accounts) {
      if (targetAcc?.id && sourceById.has(targetAcc.id)) {
        mergeNode(targetAcc, sourceById.get(targetAcc.id));
      }
    }
  }
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

  // virtual_keys 的真实密钥是键名：客户端回传的是掩码占位名，用 restoreVirtualKeys
  // 按位序恢复原名（与 redactVirtualKeys 配对，约定只活在那一对函数里）。
  if (merged.virtual_keys && typeof merged.virtual_keys === "object" && existing?.virtual_keys) {
    merged.virtual_keys = restoreVirtualKeys(merged.virtual_keys, existing.virtual_keys);
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
  // provider id 集合只构建一次，供“重复 id 检测”与“routes 引用校验”复用
  const providerIds = new Set();
  if (!Array.isArray(config.providers) && !(config.providers && typeof config.providers === "object")) {
    errors.push("providers must be an array or object");
  } else {
    const seenAccountIds = new Set();
    eachProvider(config.providers, (provider) => {
      if (!provider || typeof provider !== "object") {
        errors.push("providers must contain provider objects");
        return;
      }
      const pid = provider.id || "<unknown>";
      if (!provider.id || typeof provider.id !== "string") {
        errors.push("provider.id is required");
      } else {
        if (providerIds.has(provider.id)) {
          errors.push(`duplicate provider id "${provider.id}"`);
        }
        providerIds.add(provider.id);
      }
      // Note: provider.type validation is done at createProvider time, not validate time
      // to maintain backward compatibility with tests that omit type in initial saves
      if (provider.enabled !== false) {
        const accounts = provider.config?.accounts;
        if (Array.isArray(accounts) && accounts.length === 0) {
          errors.push(`provider "${pid}" has zero accounts`);
        }
        if (Array.isArray(accounts)) {
          accounts.forEach((account, i) => {
            if (!account || typeof account !== "object") {
              errors.push(`provider "${pid}" account[${i}] must be an object`);
              return;
            }
            if (!account.id || typeof account.id !== "string") {
              errors.push(`provider "${pid}" account[${i}] is missing id`);
              return;
            }
            const accountKey = `${pid}:${account.id}`;
            if (seenAccountIds.has(accountKey)) {
              errors.push(`provider "${pid}" has duplicate account id "${account.id}"`);
            }
            seenAccountIds.add(accountKey);
          });
        }
      }
    });
  }
  if (!config.routes || typeof config.routes !== "object" || Array.isArray(config.routes)) {
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
        } else if (!providerIds.has(r.provider)) {
          errors.push(`routes["${model}"][${i}] references unknown provider "${r.provider}"`);
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

  // 版本冲突检测：如果新配置提供了 config_version 且不匹配当前版本，返回 409
  if (newConfig.config_version !== undefined && existing?.config_version !== undefined) {
    if (newConfig.config_version !== existing.config_version) {
      const error = new Error("Config version conflict: another client modified the config");
      error.status = 409;
      throw error;
    }
  }

  const merged = mergeSecrets(existing, newConfig);
  // 递增版本号
  merged.config_version = (existing?.config_version || 0) + 1;

  // 写入前校验，拦截畸形配置。唯一的校验入口（admin 不再预检）：错误带 400 状态，
  // 由调用方（admin catch）映射为 HTTP 状态，避免“校验了两遍、状态码两处定”的分裂。
  const validationErrors = validateConfig(merged);
  if (validationErrors.length > 0) {
    const error = new Error("Invalid config: " + validationErrors.join("; "));
    error.status = 400;
    throw error;
  }
  await kv.put("GATEWAY_CONFIG", JSON.stringify(merged, null, 2));
  // 立即热同步当前 Isolate 内存缓存
  cachedConfig = merged;
  cachedConfigTimestamp = Date.now();
  return true;
}
