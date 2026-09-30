import type { LLMProvider } from "../provider.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
} from "@easy-agent/schema/llm";

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private baseUrl: string;

  constructor(config: { baseUrl?: string }) {
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      const data = (await res.json()) as any;
      return (data.models ?? []).map((m: any) => ({
        id: m.name,
        name: m.name,
        provider: "ollama",
        contextWindow: 8192,
        supportsTools: false,
        supportsVision: false,
        inputCostPerMToken: 0,
        outputCostPerMToken: 0,
      }));
    } catch {
      return [];
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const messages = this.buildMessages(request);
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: request.model, messages, stream: false }),
    });

    if (!res.ok) throw new Error(`Ollama: ${res.status}`);
    const data = (await res.json()) as any;

    return {
      content: data.message?.content ?? "",
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      finishReason: "stop",
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        messages: this.buildMessages(request),
        stream: true,
      }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.message?.content)
            yield { type: "text", text: data.message.content };
          if (data.done) yield { type: "done", finishReason: "stop" };
        } catch {}
      }
    }
  }

  private buildMessages(request: LLMRequest): any[] {
    const msgs: any[] = [];
    if (request.system) msgs.push({ role: "system", content: request.system });
    for (const m of request.messages) {
      if (m.role === "system") continue;
      msgs.push({ role: m.role, content: m.content });
    }
    return msgs;
  }
}
