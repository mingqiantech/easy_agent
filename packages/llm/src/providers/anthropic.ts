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

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client: ReturnType<typeof createAnthropic>;

  constructor(config: { apiKey: "***"; baseUrl?: string }) {
    this.client = createAnthropic({
      apiKey: "***",
      baseURL: config.baseUrl,
    });
  }
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        provider: "anthropic",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsVision: true,
        inputCostPerMToken: 3,
        outputCostPerMToken: 15,
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        provider: "anthropic",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsVision: true,
        inputCostPerMToken: 15,
        outputCostPerMToken: 75,
      },
      {
        id: "claude-haiku-3-5-20241022",
        name: "Claude 3.5 Haiku",
        provider: "anthropic",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsTools: true,
        supportsVision: true,
        inputCostPerMToken: 0.8,
        outputCostPerMToken: 4,
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
        maxTokens: request.generation?.maxTokens ?? 8192,
      });
      return {
        content: result.text,
        toolCalls: result.toolCalls?.map((tc) => ({
          id: tc.toolCallId,
          name: tc.toolName,
          input: tc.input,
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
      throw new Error("Anthropic API error: ${error.message}");
    }
  }
  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const model = this.client(request.model);
    const messages = this.convertMessages(request.messages);
    const tool = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    const result = streamText({
      model,
      system: request.system,
      messages,
      tools,
      temperature: request.generation?.temperature,
      maxTokens: request.generation?.maxTokens ?? 8192,
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
          yield { type: "tool_call_end", id: part.toolCallId };
          break;
        case "error":
          yield { type: "error", error: String(part.error) };
          break;
      }
    }
    yield { type: "done", finishReason: "stop" };
  }
  private convertMessages(messages: Message[]): any[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((msg) => ({
        role: msg.role === "tool" ? "user" : msg.role,
        content: msg.content,
      }));
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
