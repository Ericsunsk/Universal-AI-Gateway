// Provider 注册表 —— 新增供应商 = 新目录 + 一行注册，不再改 switch。
// 注册表只认“类型名 → 构造器”，与 adapter 实现零耦合；fleet 与测试只经
// createProvider 取实例，不直引具体 adapter。
//
// 结构性不变量一律在注册处校验：重复构造器冲突、方言可判定性。注册是唯一入口，
// 在此拒绝比在每个消费端各判一次更浅也更通用。
import { REASONING_DIALECTS } from "../core/contract.js";

const registry = new Map();

// 判定「构造器声明了合法推理方言」，返回 null 表示通过，否则返回错误描述。
//
// 方言可以走两条路径声明，二者皆合法：
//   1. 写死字面量 —— 实例属性或原型默认值（仓内三个 adapter 均如此）；
//   2. 由 config 驱动 —— 以 FleetConfig 条目新增的第三方上游，方言来自 pConf。
// 第 2 种在注册期探不出（探针用空 config），此时放行，交由 fleet 构建期
// assertReasoningDialect 用真实实例兜底。故此处只拒绝「字面量声明了非法值」
// 这一确定违约，不误伤 config 驱动的合法 adapter。
function dialectDefect(ProviderClass) {
  const literal = ProviderClass.prototype?.reasoningDialect;
  if (literal === undefined) return null; // config 驱动，构建期再判
  if (REASONING_DIALECTS.includes(literal)) return null;
  return (
    `Provider type declares an invalid reasoningDialect ` +
    `(got ${JSON.stringify(literal)}); ` +
    `须为 ${REASONING_DIALECTS.join(" | ")} 之一（见 core/contract.js）`
  );
}

// 注册一个供应商类型。重复注册不同构造器直接抛错（多半是复制粘贴事故），
// 同一构造器重复注册视为幂等（测试与热重载安全）。
export function registerProvider(type, ProviderClass) {
  if (!type || typeof type !== "string") {
    throw new Error("registerProvider requires a non-empty string type");
  }
  if (typeof ProviderClass !== "function") {
    throw new Error(`registerProvider("${type}") requires a constructor`);
  }
  const existing = registry.get(type);
  if (existing && existing !== ProviderClass) {
    throw new Error(`Provider type "${type}" is already registered`);
  }
  // 仅对首次注册校验：同构造器重复注册已在上面判为幂等，不必重复探测。
  if (!existing) {
    const defect = dialectDefect(ProviderClass);
    if (defect) throw new Error(`registerProvider("${type}"): ${defect}`);
  }
  registry.set(type, ProviderClass);
}

export function supportedProviderTypes() {
  return [...registry.keys()];
}

export function createProvider(providerConfig, env) {
  if (!providerConfig) return null;
  const ProviderClass = registry.get(providerConfig.type);
  if (!ProviderClass) {
    throw new Error(
      `Unknown provider type "${providerConfig.type}". ` +
      `Supported types: ${supportedProviderTypes().join(", ")}`
    );
  }
  return new ProviderClass(providerConfig, env);
}
