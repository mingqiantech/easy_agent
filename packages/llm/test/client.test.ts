import { describe, it, expect } from "bun:test";
import { registerProvider } from "../src/registry.js";
import { LLMClient } from "../src/client.js";
import type { LLMProvider } from "../src/provider.js";
import type { LLMRequest, LLMResponse } from "@easy-agent/schema/llm";

let fallbackCalls = 0;

class FailingProvider implements LLMProvider {
  readonly name = "failp";
  async listModels() {
    return [];
  }
  async generate(_req: LLMRequest): Promise<LLMResponse> {
    throw new Error("primary down");
  }
  async *stream(_req: LLMRequest) {
    throw new Error("stream down");
    yield { type: "done" as const, finishReason: "stop" };
  }
}

class PartialStreamProvider implements LLMProvider {
  readonly name = "partialp";
  async listModels() {
    return [];
  }
  async generate(): Promise<LLMResponse> {
    throw new Error("unused");
  }
  async *stream() {
    yield { type: "text" as const, text: "got partial" };
    throw new Error("mid stream explode");
  }
}

class OkProvider implements LLMProvider {
  readonly name = "okp";
  async listModels() {
    return [];
  }
  async generate(): Promise<LLMResponse> {
    fallbackCalls++;
    return {
      content: "from fallback",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async *stream() {
    fallbackCalls++;
    yield { type: "text" as const, text: "ok" };
    yield { type: "done" as const, finishReason: "stop" };
  }
}

registerProvider("failp", () => new FailingProvider());
registerProvider("okp", () => new OkProvider());
registerProvider("partialp", () => new PartialStreamProvider());

const providers = {
  failp: { apiKey: "***" },
  okp: { apiKey: "***" },
  partialp: { apiKey: "***" },
};

describe("LLMClient failover (OpenClaw 方案)", () => {
  const client = new LLMClient({
    providers,
    fallbacks: { "failp/primary": ["okp/backup"], "partialp/a": ["okp/backup"] },
  });

  it("generate falls back to next model in chain", async () => {
    const before = fallbackCalls;
    const res = await client.generate({ model: "failp/primary", messages: [] });
    expect(res.content).toBe("from fallback");
    expect(fallbackCalls).toBe(before + 1);
  });

  it("without fallback config, original error propagates", async () => {
    const plain = new LLMClient({ providers });
    await expect(
      plain.generate({ model: "failp/primary", messages: [] }),
    ).rejects.toThrow("primary down");
  });

  it("stream retries before first event only", async () => {
    const before = fallbackCalls;
    const events: string[] = [];
    for await (const ev of client.stream({ model: "failp/primary", messages: [] })) {
      events.push(ev.type);
    }
    expect(events).toContain("text");
    expect(fallbackCalls).toBe(before + 1);
  });

  it("mid-stream error is NOT retried (no duplicate output)", async () => {
    const before = fallbackCalls;
    const texts: string[] = [];
    let caught: Error | undefined;
    try {
      for await (const ev of client.stream({ model: "partialp/a", messages: [] })) {
        if (ev.type === "text") texts.push(ev.text);
      }
    } catch (e: any) {
      caught = e;
    }
    expect(texts).toEqual(["got partial"]); // 已吐内容保留
    expect(caught?.message).toContain("mid stream explode"); // 不重连 fallback
    expect(fallbackCalls).toBe(before);
  });
});
