import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";
import type { LLMProvider } from "../provider.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
} from "@easy-agent/schema/llm";

/**
 * OpenRouter — 统一接入 100+ 模型
 * 使用 OpenAI 兼容接口，baseURL 指向 OpenRouter
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  private client: ReturnType<typeof createOpenAI>;

  constructor(config: { apiKey: string }) {
    this.client = createOpenAI({
      apiKey: config.apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://easy-agent.local",
        "X-Title": "My Agent",
      },
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4 (via OR)",
        provider: "openrouter",
        contextWindow: 200000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "openai/gpt-4o",
        name: "GPT-4o (via OR)",
        provider: "openrouter",
        contextWindow: 128000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "google/gemini-2.0-flash",
        name: "Gemini 2.0 Flash (via OR)",
        provider: "openrouter",
        contextWindow: 1048576,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "meta-llama/llama-3.1-70b-instruct",
        name: "Llama 3.1 70B (via OR)",
        provider: "openrouter",
        contextWindow: 131072,
        supportsTools: false,
        supportsVision: false,
      },
    ];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const result = await generateText({
      model: this.client(request.model),
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role as any,
        content: m.content,
      })),
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
        totalTokens: result.usage.promptTokens + result.usage.completionTokens,
      },
      finishReason: "stop",
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const result = streamText({
      model: this.client(request.model),
      system: request.system,
      messages: request.messages.map((m) => ({
        role: m.role as any,
        content: m.content,
      })),
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta")
        yield { type: "text", text: part.textDelta };
    }
    yield { type: "done", finishReason: "stop" };
  }
}
