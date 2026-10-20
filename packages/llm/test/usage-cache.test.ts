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
