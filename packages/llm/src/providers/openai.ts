import { createOpenAI } from "@easy-agent/openai";
import { generateText, streamText } from "ai";
import type { LLMProvider } from "../provider.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
  Message,
} from "@easy-agent/schema/llm";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private client: ReturnType<typeof createOpenAI>;
}
