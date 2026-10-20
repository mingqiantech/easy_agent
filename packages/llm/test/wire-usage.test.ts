import { describe, it, expect } from "bun:test";
import { parseSseUsage, usageFromWire } from "../src/providers/anthropic.js";

const sse = (ev: object) => `data: ${JSON.stringify(ev)}\n\n`;

describe("parseSseUsage / usageFromWire", () => {
  it("message_start 写缓存：uncached+cacheWrite", () => {
    const w = parseSseUsage(
      sse({ type: "message_start", message: { usage: { input_tokens: 13, cache_creation_input_tokens: 1094, cache_read_input_tokens: 0, output_tokens: 2 } } }) +
      sse({ type: "message_delta", usage: { output_tokens: 24 } }),
    )!;
    expect(w.uncachedInput).toBe(13);
    expect(w.cacheWrite).toBe(1094);
    expect(w.output).toBe(24);
    const u = usageFromWire(w, 999, 999);
    expect(u.promptTokens).toBe(1107);
    expect(u.cacheWriteTokens).toBe(1094);
    expect(u.totalTokens).toBe(1131);
  });
  it("读缓存：cacheRead 计入 prompt", () => {
    const w = parseSseUsage(
      sse({ type: "message_start", message: { usage: { input_tokens: 13, cache_read_input_tokens: 1463, cache_creation_input_tokens: 0, output_tokens: 2 } } }) +
      sse({ type: "message_delta", usage: { input_tokens: 1475, output_tokens: 30 } }),
    )!;
    const u = usageFromWire(w, 0, 0);
    expect(u.promptTokens).toBe(1476);
    expect(u.cacheReadTokens).toBe(1463);
    expect(u.completionTokens).toBe(30);
  });
  it("双口径保护：input 已是全量时不叠加", () => {
    const w = parseSseUsage(
      sse({ type: "message_start", message: { usage: { input_tokens: 3211, cache_read_input_tokens: 3200, output_tokens: 2 } } }),
    )!;
    const u = usageFromWire(w, 0, 0);
    expect(u.promptTokens).toBe(3211); // 不变成 6411
    expect(u.cacheReadTokens).toBe(3200);
  });
  it("无缓存/无 usage：退回 fallback", () => {
    const u = usageFromWire(undefined, 100, 20);
    expect(u.promptTokens).toBe(100);
    expect(u.totalTokens).toBe(120);
    expect(u.cacheReadTokens).toBeUndefined();
    expect(parseSseUsage("data: not json\n")).toBeUndefined();
  });
});
