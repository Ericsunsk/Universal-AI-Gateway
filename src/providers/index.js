import { WorkBuddyProvider } from "./workbuddy.js";
import { OpenAIStandardProvider } from "./openai_standard.js";
import { AnthropicStandardProvider } from "./anthropic_standard.js";
import { OpenCodeProvider } from "./opencode.js";

const SUPPORTED_PROVIDER_TYPES = ["workbuddy", "opencode", "openai", "anthropic"];

export function createProvider(providerConfig, env) {
  if (!providerConfig) return null;
  switch (providerConfig.type) {
    case "workbuddy":
      return new WorkBuddyProvider(providerConfig, env);
    case "opencode":
      return new OpenCodeProvider(providerConfig, env);
    case "openai":
      return new OpenAIStandardProvider(providerConfig, env);
    case "anthropic":
      return new AnthropicStandardProvider(providerConfig, env);
    default:
      throw new Error(
        `Unknown provider type "${providerConfig.type}". ` +
        `Supported types: ${SUPPORTED_PROVIDER_TYPES.join(", ")}`
      );
  }
}
