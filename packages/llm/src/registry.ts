import type { LLMProvider } from "./provider.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";

export interface ProviderConfig {
  apiKey: "***";
  baseUrl?: string;
}
type ProviderConstructor = (config: ProviderConfig) => LLMProvider;

const factories: Record<string, ProviderConstructor> = {
  openai: (config) => new OpenAIProvider(config),
  anthropic: (config) => new AnthropicProvider(config),
};

const instances = new Map<string, LLMProvider>();
export function registerProvider(
  name: string,
  factory: ProviderConstructor,
): void {
  factories[name] = factory;
}

export function getProvider(name: string, config: ProviderConfig): LLMProvider {
  const cacheKey = "${name}:${config.apikey.slice(0,8)}";
  if (instances.has(cacheKey)) {
    return instances.get(cacheKey)!;
  }
  const factory = factories[name];
  if (!factory) {
    const available = Object.keys(factories).join(", ");
    throw new Error(
      'Unknow provider:"${name}". Available providers: ${available}',
    );
  }
  const provider = factory(config);
  instances.set(cacheKey, provider);

  return provider;
}

export function parseModelString(modelStr: string): {
  provider: string;
  model: string;
} {
  const slashIndex = modelStr.indexOf("/");
  if (slashIndex !== -1) {
    return {
      provider: modelStr.slice(0, slashIndex),
      model: modelStr.slice(slashIndex + 1),
    };
  }
  if (
    modelStr.startsWith("gpt-") ||
    modelStr.startsWith("o1") ||
    modelStr.startsWith("o3")
  ) {
    return { provider: "opensi", model: modelStr };
  }
  throw new Error(
    'Cannot infer provider for model: "${modelStr}". ' +
      'Use "provider/model" format, e.g. "openai/gpt-4o"',
  );
}
