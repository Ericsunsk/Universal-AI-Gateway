// 基于 Valibot 的网关配置 Schema 验证器（轻量、高性能）
import * as v from "valibot";

// 账号定义
export const AccountConfigSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  enabled: v.optional(v.boolean(), true),
  userId: v.optional(v.string(), ""),
  accessToken: v.optional(v.string(), ""),
  refreshToken: v.optional(v.string(), "")
});

// 单个 Provider 配置
export const ProviderConfigSchema = v.looseObject({
  id: v.string(),
  name: v.optional(v.string()),
  type: v.string(),
  enabled: v.optional(v.boolean(), true),
  config: v.optional(v.looseObject({
    region: v.optional(v.string()),
    accounts: v.optional(v.array(AccountConfigSchema))
  }), {})
});

// 路由候选者
export const RouteCandidateSchema = v.looseObject({
  provider: v.string(),
  model: v.optional(v.string())
});

// 虚拟密钥
export const VirtualKeySchema = v.looseObject({
  name: v.optional(v.string()),
  enabled: v.optional(v.boolean(), true),
  models: v.optional(v.array(v.string()), ["*"]),
  role: v.optional(v.string(), "client")
});

// 网关总配置 Schema（严格校验各模块，内嵌领域 Schema，消除松散兼容垫片）
export const GatewayConfigSchema = v.looseObject({
  config_version: v.optional(v.number(), 1),
  master_key: v.optional(v.string()),
  cron_secret: v.optional(v.string(), ""),
  max_context_turns: v.optional(v.number(), 0),
  usage_provider_id: v.optional(v.string(), "workbuddy"),
  default_provider: v.optional(v.string(), "workbuddy"),
  providers: v.optional(
    v.union([
      v.array(ProviderConfigSchema),
      v.record(v.string(), ProviderConfigSchema)
    ])
  ),
  routes: v.optional(
    v.record(v.string(), v.array(RouteCandidateSchema)),
    {}
  ),
  virtual_keys: v.optional(
    v.record(v.string(), VirtualKeySchema),
    {}
  )
});

/**
 * 校验并清洗网关配置对象
 * @param {unknown} input
 * @returns {{ success: boolean, output?: object, errors?: string[] }}
 */
export function validateGatewayConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { success: false, errors: ["Config must be an object"] };
  }
  const result = v.safeParse(GatewayConfigSchema, input);
  if (!result.success) {
    return {
      success: false,
      errors: result.issues.map(i => `${i.path?.map(p => p.key).join(".") || "root"}: ${i.message}`)
    };
  }
  return { success: true, output: result.output };
}
