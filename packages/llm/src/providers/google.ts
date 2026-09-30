import type { LLMProvider } from "../provider.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
} from "@easy-agent/schema/llm";

export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl =
      config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        provider: "google",
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        inputCostPerMToken: 0.1,
        outputCostPerMToken: 0.4,
      },
      {
        id: "gemini-1.5-pro",
        name: "Gemini 1.5 Pro",
        provider: "google",
        contextWindow: 2097152,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        inputCostPerMToken: 1.25,
        outputCostPerMToken: 5,
      },
    ];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const url = `${this.baseUrl}/models/${request.model}:generateContent?key=${this.apiKey}`;
    const contents = this.buildContents(request);

    const body: any = { contents };
    if (request.generation?.temperature !== undefined) {
      body.generationConfig = {
        temperature: request.generation.temperature,
        maxOutputTokens: request.generation.maxTokens,
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok)
      throw new Error(`Google API: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;

    const text =
      data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ??
      "";
    const usage = data.usageMetadata;

    return {
      content: text,
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      finishReason: "stop",
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const url = `${this.baseUrl}/models/${request.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: this.buildContents(request) }),
    });

    if (!res.ok) {
      yield { type: "error", error: `HTTP ${res.status}` };
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          const text =
            data.candidates?.[0]?.content?.parts
              ?.map((p: any) => p.text)
              .join("") ?? "";
          if (text) yield { type: "text", text };
        } catch {}
      }
    }
    yield { type: "done", finishReason: "stop" };
  }

  private buildContents(request: LLMRequest): any[] {
    const contents: any[] = [];
    for (const msg of request.messages) {
      if (msg.role === "system") continue;
      const role = msg.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: [{ text: msg.content }] });
    }
    return contents;
  }
}
