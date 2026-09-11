let cachedConfig = null;
let cachedConfigTimestamp = 0;
const CONFIG_CACHE_TTL_MS = 60 * 1000; // 60 秒内存热缓存，彻底消除每请求访问 KV 的网络往返开销

export function getDefaultConfig(env) {
  const defaultApiKey = env.API_KEY || "sk-workbuddy-deepseek";
  const masterKey = env.MASTER_KEY || defaultApiKey;

  return {
    master_key: masterKey,
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
        { provider: "openrouter", model: "deepseek/deepseek-chat" }
      ],
      "deepseek-v4-flash": [
        { provider: "workbuddy", model: "deepseek-v4-flash" }
      ],
      "deepseek-v4-pro": [
        { provider: "workbuddy", model: "deepseek-v4-pro" },
        { provider: "openrouter", model: "deepseek/deepseek-r1" }
      ],
      "claude-3-7-sonnet-20250219": [
        { provider: "workbuddy", model: "claude-3-7-sonnet-20250219" },
        { provider: "openrouter", model: "anthropic/claude-3.7-sonnet" }
      ],
      "claude-3-5-sonnet-20241022": [
        { provider: "workbuddy", model: "claude-3-5-sonnet-20241022" },
        { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" }
      ],
      "claude-3-5-haiku-20241022": [
        { provider: "workbuddy", model: "claude-3-5-haiku-20241022" }
      ],
      "glm-5.2": [
        { provider: "workbuddy", model: "glm-5.2" }
      ],
      "kimi-k3-1": [
        { provider: "workbuddy", model: "kimi-k3-1" }
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

export async function saveConfig(env, newConfig) {
  const kv = env.GATEWAY_KV || env.WORKBUDDY_KV;
  if (!kv) {
    throw new Error("KV Namespace GATEWAY_KV is not bound");
  }
  await kv.put("GATEWAY_CONFIG", JSON.stringify(newConfig, null, 2));
  // 立即热同步当前 Isolate 内存缓存
  cachedConfig = newConfig;
  cachedConfigTimestamp = Date.now();
  return true;
}
