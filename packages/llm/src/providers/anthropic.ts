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

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: ReturnType<typeof createAnthropic>;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.client = createAnthropic({
      apiKey: config.apiKey,
      // token-plan 订阅密钥只认 Authorization: Bearer（单独 x-api-key 返回 401）；
      // 两个头同发，兼容标准 Anthropic 端点与网关端点
      headers: { Authorization: "Bearer " + config.apiKey },
      // baseURL 规范化：openclaw 风格 baseUrl 不带 /v1，ai-sdk 需要 {base}/v1
      baseURL: (function () {
        const b = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
        return /\/v1\d?$/.test(b) ? b : b + "/v1";
      })(),
    });
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
  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = this.client(request.model);
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    try {
      const result = await generateText({
        model,
        system: request.system,
        messages,
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
        usage: {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens:
            result.usage.promptTokens + result.usage.completionTokens,
        },
        finishReason:
          result.finishReason == "tool-calls" ? "tool_calls" : "stop",
      };
    } catch (error: any) {
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const model = this.client(request.model);
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    const result = streamText({
      model,
      system: request.system,
      messages,
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
      yield {
        type: "usage",
        usage: {
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          totalTokens: u.promptTokens + u.completionTokens,
        },
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
