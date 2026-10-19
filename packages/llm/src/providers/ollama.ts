import { z } from "zod";
import type { LLMProvider } from "../provider.js";
import type {
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  ModelInfo,
} from "@easy-agent/schema/llm";
import { zodToJsonSchema } from "../json-schema.js";

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
        contextWindow: m.context_window ?? 8192,
        supportsTools: true,
        supportsVision: false,
        inputCostPerMToken: 0,
        outputCostPerMToken: 0,
      }));
    } catch {
      return [];
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const body: any = {
      model: request.model,
      messages: this.buildMessages(request),
      stream: false,
      options: request.generation?.temperature !== undefined
        ? { temperature: request.generation.temperature }
        : undefined,
    };
    const tools = this.buildTools(request);
    if (tools) body.tools = tools;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok) throw new Error(`Ollama: ${res.status} ${await res.text().catch(() => "")}`);
    const data = (await res.json()) as any;

    const toolCalls = (data.message?.tool_calls ?? []).map((tc: any, i: number) => ({
      id: tc.id ?? `ollama_tc_${i}`,
      name: tc.function?.name,
      input: normalizeArgs(tc.function?.arguments),
    }));

    return {
      content: data.message?.content ?? "",
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      finishReason: toolCalls.length ? "tool_calls" : "stop",
    };
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const body: any = {
      model: request.model,
      messages: this.buildMessages(request),
      stream: true,
    };
    const tools = this.buildTools(request);
    if (tools) body.tools = tools;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok) {
      yield { type: "error", error: `Ollama: ${res.status}` };
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // ollama 流式中 tool_calls 可能整块到达或分块（arguments 字符串拼接）
    const acc = new Map<number, { id: string; name: string; args: string }>();
    let doneEvent: LLMStreamEvent = { type: "done", finishReason: "stop" };
    let usage: LLMResponse["usage"] | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }
        if (data.message?.content)
          yield { type: "text", text: data.message.content };
        for (const [i, tc] of (data.message?.tool_calls ?? []).entries()) {
          const cur = acc.get(i) ?? {
            id: tc.id ?? `ollama_tc_${i}`,
            name: tc.function?.name ?? "",
            args: "",
          };
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.id) cur.id = tc.id;
          const a = tc.function?.arguments;
          if (typeof a === "string") cur.args += a;
          else if (a && typeof a === "object")
            cur.args = JSON.stringify(a); // 整块对象
          acc.set(i, cur);
        }
        if (data.done) {
          if (data.prompt_eval_count !== undefined)
            usage = {
              promptTokens: data.prompt_eval_count,
              completionTokens: data.eval_count ?? 0,
              totalTokens:
                data.prompt_eval_count + (data.eval_count ?? 0),
            };
          doneEvent = {
            type: "done",
            finishReason: acc.size ? "tool_calls" : "stop",
          };
        }
      }
    }

    for (const [, tc] of acc) {
      yield { type: "tool_call_start", id: tc.id, name: tc.name };
      yield { type: "tool_call_delta", id: tc.id, input: tc.args || "{}" };
      yield { type: "tool_call_end", id: tc.id };
    }
    if (usage) yield { type: "usage", usage };
    yield doneEvent;
  }

  private buildTools(request: LLMRequest): any[] | undefined {
    if (!request.tools?.length) return undefined;
    return request.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: zodToJsonSchema(t.inputSchema as z.ZodType<any>),
      },
    }));
  }

  private buildMessages(request: LLMRequest): any[] {
    const msgs: any[] = [];
    if (request.system) msgs.push({ role: "system", content: request.system });
    for (const m of request.messages) {
      if (m.role === "system") continue;
      if (m.role === "assistant") {
        // 我们的存储格式：纯文本，或 JSON {text, toolCalls}
        let parsed: any = null;
        try {
          parsed = JSON.parse(m.content);
        } catch {}
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length) {
          msgs.push({
            role: "assistant",
            content: parsed.text ?? "",
            tool_calls: parsed.toolCalls.map((tc: any) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.input ?? {} },
            })),
          });
        } else {
          msgs.push({ role: "assistant", content: parsed?.text ?? m.content });
        }
        continue;
      }
      if (m.role === "tool") {
        // 存储格式：JSON {toolCallId, toolName, result, error}
        let parsed: any = null;
        try {
          parsed = JSON.parse(m.content);
        } catch {}
        msgs.push({
          role: "tool",
          tool_call_id: parsed?.toolCallId,
          content: parsed ? JSON.stringify(parsed.result ?? parsed) : m.content,
        });
        continue;
      }
      msgs.push({ role: m.role, content: m.content });
    }
    return msgs;
  }
}

function normalizeArgs(a: unknown): unknown {
  if (a && typeof a === "object") return a;
  if (typeof a === "string") {
    try {
      return JSON.parse(a);
    } catch {
      return {};
    }
  }
  return {};
}
