import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText } from "ai";
import type { LLMProvider } from "../provider.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
  Message,
} from "@easy-agent/schema/llm";

export
