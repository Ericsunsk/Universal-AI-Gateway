import { WorkBuddyProvider } from "./workbuddy/index.js";
import { OpenAIStandardProvider } from "./openai_standard.js";
import { AnthropicStandardProvider } from "./anthropic_standard.js";
import { QwenWebProvider } from "./qwenweb/index.js";
import { registerProvider, supportedProviderTypes, createProvider } from "./registry.js";

// 内置供应商接线：新增供应商时加一行 registerProvider 即可，createProvider 逻辑零改动。
registerProvider("workbuddy", WorkBuddyProvider);
registerProvider("openai", OpenAIStandardProvider);
registerProvider("anthropic", AnthropicStandardProvider);
registerProvider("qwenweb", QwenWebProvider);

export { registerProvider, supportedProviderTypes, createProvider };
