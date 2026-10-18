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
export interface LLMClientConfig {
  providers: Record<string, ProviderConfig>;
  /** primary ref -> 有序 fallback refs（OpenClaw 式故障转移） */
  fallbacks?: Record<string, string[]>;
}

export class LLMClient {
  private config: LLMClientConfig;
  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  /** 请求模型 + 配置的 fallback 链 */
  private chainFor(model: string): string[] {
    const fb = this.config.fallbacks?.[model];
    return fb && fb.length > 0 ? [model, ...fb] : [model];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const chain = this.chainFor(request.model);
    let lastError: Error | undefined;
    for (const ref of chain) {
      try {
        return await this.generateOnce({ ...request, model: ref });
      } catch (e: any) {
        if (request.signal?.aborted) throw e; // 用户中断不触发故障转移
        lastError = e;
        const next = chain[chain.indexOf(ref) + 1];
        console.warn(
          `⚠️ ${ref} 失败: ${String(e?.message).slice(0, 100)}` +
            (next ? ` → 切换 ${next}` : ""),
        );
      }
    }
    throw lastError;
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const chain = this.chainFor(request.model);
    let lastError: Error | undefined;
    for (const ref of chain) {
      let yielded = false;
      try {
        for await (const ev of this.streamOnce({ ...request, model: ref })) {
          yielded = true;
          yield ev;
        }
        return;
      } catch (e: any) {
        if (request.signal?.aborted) throw e; // 用户中断不重试
        // 已经吐出内容后不重试（避免重复输出），直接向上抛
        if (yielded) throw e;
        lastError = e;
        const next = chain[chain.indexOf(ref) + 1];
        if (next) console.warn(`⚠️ ${ref} 失败 → 切换 ${next}`);
      }
    }
    throw lastError;
  }

  private async generateOnce(request: LLMRequest): Promise<LLMResponse> {
    const { provider: providerName, model } = parseModelString(request.model);
    const providerConfig = this.getProviderConfig(providerName);
    const provider = getProvider(providerName, providerConfig);
    const adjustedRequest: LLMRequest = { ...request, model };
    return provider.generate(adjustedRequest);
  }

  private async *streamOnce(
    request: LLMRequest,
  ): AsyncGenerator<LLMStreamEvent> {
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
