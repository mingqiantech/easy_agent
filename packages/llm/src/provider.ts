import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
} from "@easy-agent/schema/llm";

export interface LLMProvider {
  readonly name: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent>;
}
