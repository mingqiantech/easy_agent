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

export class LLMClient {}
