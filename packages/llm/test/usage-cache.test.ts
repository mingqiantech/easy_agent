import { AnthropicProvider } from "../src/providers/anthropic.js";
import { describe, it, expect } from "bun:test";
import { anthropicUsage } from "../src/providers/anthropic.js";

describe("Anthropic usage 归一（缓存段并入总输入）", () => {
  it("input_tokens 不含缓存 → promptTokens = 非缓存+读+写", () => {
    const u = anthropicUsage(200, 50, { cacheReadInputTokens: 8000, cacheCreationInputTokens: 100 });
    expect(u.promptTokens).toBe(8300);
    expect(u.totalTokens).toBe(8350);
    expect(u.cacheReadTokens).toBe(8000);
    expect(u.cacheWriteTokens).toBe(100);
  });
  it("无缓存字段（首轮/不支持）→ 原样且 cache 为 undefined", () => {
    const u = anthropicUsage(100, 20, undefined);
    expect(u.promptTokens).toBe(100);
    expect(u.cacheReadTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
  });
  it("null 值（协议 nullish）→ 0 且省略字段", () => {
    const u = anthropicUsage(100, 20, { cacheReadInputTokens: null, cacheCreationInputTokens: null });
    expect(u.totalTokens).toBe(120);
    expect(u.cacheReadTokens).toBeUndefined();
  });
});

describe("尾缓存断点 markTailCache（滚动前缀）", () => {
  const provider = new AnthropicProvider({ apiKey: "test-key-not-used" });
  const CC = { anthropic: { cacheControl: { type: "ephemeral" } } };
  it("最后一条消息盖断点，其余不动，且不改原数组", () => {
    const msgs: any[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "t", result: {} }] },
    ];
    const out = provider.markTailCache(msgs);
    expect(out[2].experimental_providerMetadata).toEqual(CC);
    expect(out[0].experimental_providerMetadata).toBeUndefined();
    expect(out[1].experimental_providerMetadata).toBeUndefined();
    expect(msgs[2].experimental_providerMetadata).toBeUndefined(); // 原对象不被 mutate
    expect(out).not.toBe(msgs);
  });
  it("空数组原样返回", () => {
    expect(provider.markTailCache([])).toEqual([]);
  });
  it("末尾已有断点（短历史里的 system）不重复盖", () => {
    const msgs: any[] = [{ role: "system", content: "s", experimental_providerMetadata: CC }];
    const out = provider.markTailCache(msgs);
    expect(out[0]).toBe(msgs[0]); // 完全同一引用，未复制修改
  });
  it("合并已有其他 providerMetadata 不丢失", () => {
    const msgs: any[] = [{ role: "user", content: "hi", experimental_providerMetadata: { openai: { x: 1 } } }];
    const out = provider.markTailCache(msgs);
    expect(out[0].experimental_providerMetadata).toEqual({ openai: { x: 1 }, ...CC });
  });
});
