import {
  getProvider,
  parseModelString,
  type ProviderConfig,
} from "./registry.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
} from "@easy-agent/schema/llm";
export interface LLMCliientConfig {
  providers: Record<string, ProviderConfig>;
}

export class LLMClient {
  private config: LLMCliientConfig;
  constructor(config: LLMCliientConfig) {
    this.config = config;
  }
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const { provider: providerName, model } = parseModelString(request.model);
    const providerConfig = this.getProviderConfig(providerName);
    const provider = getProvider(providerName, providerConfig);
    const adjustedRequest: LLMRequest = { ...request, model };
    return provider.generate(adjustedRequest);
  }
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const { provider: providerName, model } = parseModelString(request.model);
    const providerConfig = this.getProviderConfig(providerName);
    const provider = getProvider(providerName, providerConfig);
    const adjustedRequest: LLMRequest = { ...request, model };
    yield* provider.stream(adjustedRequest);
  }
  private getProviderConfig(name: string): ProviderConfig {
    const config = this.config.providers[name];
    if (!config) {
      const available = Object.keys(this.config.providers).join(", ");
      throw new Error(
        `No API key configured for provider: "${name}". ` +
          `Configured providers: ${available || "(none)"}. ` +
          `Set the API key via environment variable or config file.`,
      );
    }
    return config;
  }
}
