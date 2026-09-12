import { WorkBuddyProvider } from "./workbuddy.js";
import { OpenAIStandardProvider } from "./openai_standard.js";
import { AnthropicStandardProvider } from "./anthropic_standard.js";
import { TraeProvider } from "./trae.js";

export function createProvider(providerConfig, env) {
  if (!providerConfig) return null;
  switch (providerConfig.type) {
    case "workbuddy":
      return new WorkBuddyProvider(providerConfig, env);
    case "trae":
      return new TraeProvider(providerConfig, env);
    case "openai":
      return new OpenAIStandardProvider(providerConfig, env);
    case "anthropic":
      return new AnthropicStandardProvider(providerConfig, env);
    default:
      console.warn("Unknown provider type:", providerConfig.type);
      return new OpenAIStandardProvider(providerConfig, env);
  }
}
