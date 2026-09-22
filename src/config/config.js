export const VERSION = "2.5.0";

let cachedConfig = null;
let cachedConfigTimestamp = 0;
const CONFIG_CACHE_TTL_MS = 60 * 1000; // 60 秒内存热缓存，彻底消除每请求访问 KV 的网络往返开销

export function requireSecret(env, name) {
  const value = env?.[name] || (typeof process !== "undefined" ? process.env?.[name] : undefined);
  if (!value || typeof value !== "string" || !value.trim()) {
    throw new Error(
      `Missing required secret "${name}". Refusing to fall back to a hardcoded default — ` +
      `set it in .env.local (local) or Vercel environment variables.`
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
    max_context_turns: env.MAX_CONTEXT_TURNS !== undefined ? parseInt(env.MAX_CONTEXT_TURNS, 10) : 0,
    usage_provider_id: "workbuddy",
    providers: [
      {
        id: "workbuddy",
        name: "WorkBuddy (腾讯云代码助手)",
        type: "workbuddy",
        enabled: true,
        config: {
          accounts: [
            {
              id: "account-1",
              name: "Account 1",
              enabled: true,
              userId: env.USER_ID || "",
              accessToken: env.ACCESS_TOKEN || "",
              refreshToken: env.REFRESH_TOKEN || ""
            }
          ]
        }
      },
      {
        // 国际站：有 INTL_* 环境凭证即启用（与 CN 共用同一套 adapter，按 region 切端点）。
        // 凭证走 Vercel 环境变量（Environment Variables），永不进代码库；无凭证时保持 disabled，零运行时影响。
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
            name: "Intl Account 1",
            enabled: true,
            userId: intlUserId,
            accessToken: readEnv("INTL_ACCESS_TOKEN") || "",
            refreshToken: readEnv("INTL_REFRESH_TOKEN") || ""
          }] : []
        }
      },
    ],
    routes: {
      "deepseek-v4.1-flash": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "deepseek-v4-flash": [
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "deepseek-v4-pro": [
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4.1-flash" }
      ],
      "claude-3-7-sonnet-20250219": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "claude-3-5-sonnet-20241022": [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "claude-3-5-haiku-20241022": [
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "claude-3-haiku-20240307": [
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "claude-3-opus-20240229": [
        { provider: "workbuddy", model: "deepseek-v4-pro" }
      ],
      "glm-5.2": [
        { provider: "workbuddy", model: "glm-5.2" }
      ],
      "kimi-k3-1": [
        { provider: "workbuddy", model: "kimi-k3-1" }
      ],
      // 国际站已验证 serve 的路由（glm-5.2 实测 200）。intl provider 无凭证时保持 disabled，
      // 存量 KV 因回填约束（引用 provider 必须存在）自动跳过本条，不影响现网。
      "glm-5.2-intl": [
        { provider: "workbuddy-intl", model: "glm-5.2" }
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
// 背景：KV 一旦写入就盖住代码默认，后续发版新增路由（如新的 workbuddy 模型路由）对存量环境不可见，
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


// 遍历 providers 集合，兼容数组与对象两种形态
function eachProvider(providers, fn) {
  if (!providers) return;
  if (Array.isArray(providers)) providers.forEach(fn);
  else if (typeof providers === "object") Object.values(providers).forEach(fn);
}




