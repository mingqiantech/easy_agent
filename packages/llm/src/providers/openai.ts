import { createOpenAI } from "@easy-agent/openai";
import { generateText, streamText } from "ai";
import type { LLMProvider } from "../provider.js";
import {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
  Message,
} from "@easy-agent/schema/llm";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: ReturnType<typeof createOpenAI>;
  constructor(config: { apiKey: "***"; baseUrl?: string }) {
    this.client = createOpenAI({
      apiKey: "***",
      baseURL: config.baseUrl,
    });
  }
  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai",
        contextWindow: 128000,
        maxOutputTokens: 16348,
        supportsTools: true,
        supportsVision: true,
        inputConstPerMToken: 2.5,
        outputConstPerMToken: 10,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o",
        provider: "openai",
        contextWindow: 128000,
        maxOutputTokens: 16348,
        supportsTools: true,
        supportsVision: true,
        inputConstPerMToken: 0.15,
        outputConstPerMToken: 0.6,
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o",
        provider: "openai",
        contextWindow: 1047576,
        maxOutputTokens: 23768,
        supportsTools: true,
        supportsVision: true,
        inputConstPerMToken: 2,
        outputConstPerMToken: 8,
      },
    ];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const model = this.client(request.model);
    const messages = this.convertMessages(request.system, request.message);
    const tools = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    try {
      const result = await generateText({
        model,
        messages,
        tools,
        temperature: request.generation?.temperature,
        maxTokens: request.generation?.maxTokens,
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
        finishReason: (result.finishReason = "tool-calls"
          ? "tool_calls"
          : "stop"),
      };
    } catch (error: any) {
      throw new Error("OpenAR API error:${error.message}");
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const model = this.client(request.model);
    const messages = this.convertMessages(request.system, request.messages);
    const tools = request.tools?.length
      ? this.convertTools(request.tools)
      : undefined;
    const result = streamText({
      model,
      messages,
      tools,
      temperature: request.generation?.temperature,
      maxTokens: request.generation?.maxTokens,
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
            type: "tool_call_end",
            id: part.toolCallId,
          };
          break;
        case "error":
          yield { type: "error", error: String(part.error) };
          break;
      }
    }
    const usage = await result.usage;
    if (usage) {
      yield {
        type: "usage",
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.promptTokens + usage.completionTokens,
        },
      };
    }
    yield { type: "done", finishReason: "stop" };
  }
  private convertMessages(
    system: string | undefined,
    messages: Message[],
  ): any[] {
    const result: any[] = [];
    if (system) {
      result.push({ role: "system", content: system });
    }
    for (const msg of messages) {
      if (msg.role == "system") continue;
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
    return result;
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
