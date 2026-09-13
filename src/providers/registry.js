// Provider 注册表 —— 新增供应商 = 新目录 + 一行注册，不再改 switch。
// 注册表只认“类型名 → 构造器”，与 adapter 实现零耦合；fleet 与测试只经
// createProvider 取实例，不直引具体 adapter。
const registry = new Map();

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
