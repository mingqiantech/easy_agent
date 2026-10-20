import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText } from "ai";
import type { LLMProvider } from "../provider.js";
import {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
  Message,
} from "@easy-agent/schema/llm";
import { toCoreMessages } from "../convert.js";
import {
  anthropicMaxTokens,
  anthropicThinkingOptions,
} from "../thinking.js";

/**
 * Anthropic usage 归一：协议里 input_tokens 不含缓存段（cache_read/cache_creation 单列），
 * 统一成全仓库口径：promptTokens = 非缓存 + 读缓存 + 写缓存（= 真实总输入，对得上厂商账单）。
 */
export function anthropicUsage(
  promptTokens: number,
  completionTokens: number,
  meta: { cacheReadInputTokens?: number | null; cacheCreationInputTokens?: number | null } | undefined,
): LLMResponse["usage"] {
  const cacheRead = Number(meta?.cacheReadInputTokens ?? 0) || 0;
  const cacheWrite = Number(meta?.cacheCreationInputTokens ?? 0) || 0;
  const totalPrompt = promptTokens + cacheRead + cacheWrite;
  return {
    promptTokens: totalPrompt,
    completionTokens,
    totalTokens: totalPrompt + completionTokens,
    cacheReadTokens: cacheRead || undefined,
    cacheWriteTokens: cacheWrite || undefined,
  };
}

/** wire 嗅探出的原始 usage 字段（Anthropic SSE 双事件分布） */
export interface AnthropicWireUsage {
  /** message_start.input_tokens（协议语义：不含缓存段；部分网关会填全量） */
  uncachedInput?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}

/** 从 SSE 原文提取 usage：message_start 取输入/缓存段，message_delta 取最终 output */
export function parseSseUsage(sseText: string): AnthropicWireUsage | undefined {
  let out: AnthropicWireUsage | undefined;
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    let j: any;
    try {
      j = JSON.parse(t.slice(5));
    } catch {
      continue;
    }
    const usage = j?.message?.usage ?? j?.usage;
    if (
      usage && typeof usage === "object" &&
      (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")
    ) {
      out ??= {};
      if (j?.type === "message_start") {
        if (typeof usage.input_tokens === "number") out.uncachedInput = usage.input_tokens;
        if (typeof usage.cache_read_input_tokens === "number") out.cacheRead = usage.cache_read_input_tokens;
        if (typeof usage.cache_creation_input_tokens === "number") out.cacheWrite = usage.cache_creation_input_tokens;
        if (typeof usage.output_tokens === "number") out.output = usage.output_tokens;
      } else if (j?.type === "message_delta") {
        if (typeof usage.output_tokens === "number") out.output = usage.output_tokens;
        if (typeof usage.cache_read_input_tokens === "number")
          out.cacheRead = Math.max(out.cacheRead ?? 0, usage.cache_read_input_tokens);
        if (typeof usage.cache_creation_input_tokens === "number")
          out.cacheWrite = Math.max(out.cacheWrite ?? 0, usage.cache_creation_input_tokens);
      }
    }
  }
  return out;
}

/**
 * wire usage → 全仓统一 Usage（promptTokens 含缓存，对得上厂商计费）。
 * 双口径保护：若 message_start.input_tokens 本身已是全量（远大于 cache 段且 cache 非零），
 * 不再叠加，避免双计。
 */
export function usageFromWire(
  wire: AnthropicWireUsage | undefined,
  fallbackPrompt: number,
  fallbackCompletion: number,
): LLMResponse["usage"] {
  if (!wire) return anthropicUsage(fallbackPrompt, fallbackCompletion, undefined);
  const uncached = wire.uncachedInput ?? fallbackPrompt;
  const cr = wire.cacheRead ?? 0;
  const cw = wire.cacheWrite ?? 0;
  // 全量口径特征：uncached 与缓存段同量级（比值 >0.8）→ 网关把总输入塞进了 input_tokens
  const doubleCounted = cr + cw > 0 && uncached > 0.8 * (cr + cw);
  const promptTokens = doubleCounted ? uncached : uncached + cr + cw;
  const completion = wire.output ?? fallbackCompletion;
  return {
    promptTokens,
    completionTokens: completion,
    totalTokens: promptTokens + completion,
    cacheReadTokens: cr || undefined,
    cacheWriteTokens: cw || undefined,
  };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: ReturnType<typeof createAnthropic>;
  private clientSettings: { apiKey: string; headers: Record<string, string>; baseURL: string };

  /**
   * 带 SSE usage 嗅探的 fetch 注入。
   * 背景：qwencloud 网关的流式响应里 cache 字段分布不可靠（message_start 写/读、
   * message_delta 又是全量 input_tokens 的 OpenAI 口径），ai-sdk 聚合会丢。
   * 这里 clone 响应体扫 SSE 原文，以 wire 为真值。
   */
  private sniffingFetch(sink: {
    wire?: AnthropicWireUsage;
    done?: Promise<void>;
  }): any {
    const f = async (input: any, init?: any) => {
      const res: Response = await (globalThis as any).fetch(input, init);
      try {
        const body = String(init?.body ?? "");
        if (/"stream"\s*:\s*true/.test(body)) {
          const p = res
            .clone()
            .text()
            .then((t) => {
              const u = parseSseUsage(t);
              if (u) sink.wire = u;
            })
            .catch(() => {});
          sink.done = (sink.done ?? Promise.resolve()).then(() => p);
        }
      } catch {}
      return res;
    };
    return f as unknown as typeof fetch;
  }

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.clientSettings = {
      apiKey: config.apiKey,
      // token-plan 订阅密钥只认 Authorization: Bearer（单独 x-api-key 返回 401）；
      // 两个头同发，兼容标准 Anthropic 端点与网关端点
      headers: { Authorization: "Bearer " + config.apiKey },
      // baseURL 规范化：openclaw 风格 baseUrl 不带 /v1，ai-sdk 需要 {base}/v1
      baseURL: (function () {
        const b = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
        return /\/v1\d?$/.test(b) ? b : b + "/v1";
      })(),
    };
    this.client = createAnthropic(this.clientSettings);
  }
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "qwen3.8-flash",
        name: "qwen3.8-flash",
        provider: "openai",
        contextWindow: 983616,
        maxOutputTokens: 131072,
        supportsTools: true,
        supportsVision: false,
        inputCostPerMToken: 2.5,
        outputCostPerMToken: 10,
      },
      {
        id: "glm-5.3",
        name: "glm-5.3",
        provider: "openai",
        contextWindow: 1024000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: false,
        inputCostPerMToken: 0.15,
        outputCostPerMToken: 0.6,
      },
      {
        id: "qwen3.8-max",
        name: "qwen3.8-max",
        provider: "openai",
        contextWindow: 1024000,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: false,
        inputCostPerMToken: 2,
        outputCostPerMToken: 8,
      },
    ];
  }
  /**
   * 系统提示 → 带 prompt-caching 断点的 system 消息（对齐 OpenClaw 做法）：
   * 整段 system（身份/记忆/工具定义）同一会话内逐轮不变，标 cacheControl ephemeral
   * 后命中段按 10% 计费且大幅降延迟；短 system（<800 字）不标（低于最小可缓存前缀，白付写成本）。
   * 注意：会话架构里 system 可能走 request.system，也可能以 system-role 消息混在 messages 里，
   * 两处都要盖断点。
   */
  private systemMessages(system: string | undefined): any[] {
    if (!system) return [];
    if (system.length < 800) return [{ role: "system", content: system }];
    // ai-sdk v4：system 消息 content 只能是 string，缓存断点走 experimental_providerMetadata
    return [{
      role: "system",
      content: system,
      experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
    }];
  }

  /** 给 core messages 里首条够长的 system 消息盖缓存断点 */
  private markSystemCache(messages: any[]): any[] {
    let done = false;
    return messages.map((m) => {
      if (!done && m.role === "system" && typeof m.content === "string" && m.content.length >= 800) {
        done = true;
        return {
          ...m,
          experimental_providerMetadata: { anthropic: { cacheControl: { type: "ephemeral" } } },
        };
      }
      return m;
    });
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = this.client(request.model);
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    try {
      const result = await generateText({
        model,
        messages: [...this.systemMessages(request.system), ...this.markSystemCache(messages)] as any,
        tools,
        temperature: request.generation?.temperature,
        abortSignal: request.signal,
        maxTokens: anthropicMaxTokens(
          request.generation?.thinking,
          request.generation?.maxTokens,
        ),
        providerOptions: anthropicThinkingOptions(request.generation?.thinking),
      });
      return {
        content: result.text,
        toolCalls: result.toolCalls?.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.args,
        })),
        usage: anthropicUsage(
          result.usage.promptTokens,
          result.usage.completionTokens,
          (result.experimental_providerMetadata as any)?.anthropic,
        ),
        finishReason:
          result.finishReason == "tool-calls" ? "tool_calls" : "stop",
      };
    } catch (error: any) {
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const sink: { wire?: AnthropicWireUsage; done?: Promise<void> } = {};
    const sniffClient = createAnthropic({
      ...this.clientSettings,
      fetch: this.sniffingFetch(sink) as any,
    });
    const model = sniffClient(request.model);
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    const result = streamText({
      model,
      messages: [...this.systemMessages(request.system), ...this.markSystemCache(messages)] as any,
      tools,
      temperature: request.generation?.temperature,
      abortSignal: request.signal,
      maxTokens: anthropicMaxTokens(
        request.generation?.thinking,
        request.generation?.maxTokens,
      ),
      providerOptions: anthropicThinkingOptions(request.generation?.thinking),
    });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          yield { type: "text", text: part.textDelta };
          break;
        case "tool-call":
          yield {
            type: "tool_call_start",
            id: part.toolCallId,
            name: part.toolName,
          };
          yield {
            type: "tool_call_delta",
            id: part.toolCallId,
            input: JSON.stringify(part.args ?? {}),
          };
          yield { type: "tool_call_end", id: part.toolCallId };
          break;
        case "error":
          yield { type: "error", error: String(part.error) };
          break;
      }
    }
    const u = await result.usage;
    if (u) {
      await sink.done?.catch(() => {});
      yield {
        type: "usage",
        usage: usageFromWire(sink.wire, u.promptTokens, u.completionTokens),
      };
    }
    yield { type: "done", finishReason: "stop" };
  }
  private convertMessages(messages: Message[]): any[] {
    return toCoreMessages(messages);
  }
  private convertTools(
    tools: NonNullable<LLMRequest["tools"]>,
  ): Record<string, any> {
    const result: Record<string, any> = {};
    for (const tool of tools) {
      result[tool.name] = {
        description: tool.description,
        parameters: tool.inputSchema,
      };
    }
    return result;
  }
}
