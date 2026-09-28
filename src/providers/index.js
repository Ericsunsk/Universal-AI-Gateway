// 内置 provider 注册 —— 把各 adapter 挂进 registry.js 的类型表。
// 新增上游：新建目录 + index.js，然后在此加一行 registerProvider。
import { WorkBuddyProvider } from "./workbuddy/index.js";
import { OpenAIStandardProvider } from "./openai_standard.js";
import { AnthropicStandardProvider } from "./anthropic_standard.js";
import { registerProvider, supportedProviderTypes, createProvider, declaredDialects } from "./registry.js";

// 内置供应商接线：新增供应商时加一行 registerProvider 即可，createProvider 逻辑零改动。
// registerProvider 会校验该构造器声明了合法 reasoningDialect（取值见 core/contract.js
// 的 REASONING_DIALECTS），违约在此直接抛错——故 adapter 必须声明方言，忘记声明起不来。
registerProvider("workbuddy", WorkBuddyProvider);
registerProvider("openai", OpenAIStandardProvider);
registerProvider("anthropic", AnthropicStandardProvider);

export { registerProvider, supportedProviderTypes, createProvider, declaredDialects };
