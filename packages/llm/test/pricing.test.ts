import { describe, it, expect } from "bun:test";
import { estimateCostUsd, priceFor, CACHE_READ_MULT, CACHE_WRITE_MULT } from "../src/pricing.js";

describe("priceFor 查价（全名/短名/provider 前缀）", () => {
  it("纯短名命中", () => {
    expect(priceFor("qwen3.8-flash")).toEqual({ input: 2.5, output: 10 });
  });
  it("provider/model 前缀 → 短名兜底", () => {
    expect(priceFor("qwencloud-token-plan/qwen3.8-flash")).toEqual({ input: 2.5, output: 10 });
    expect(priceFor("openai/glm-5.3")).toEqual({ input: 0.15, output: 0.6 });
  });
  it("openrouter 双重前缀：先全名再逐段", () => {
    expect(priceFor("openrouter/anthropic/claude-sonnet-4")).toEqual({ input: 3, output: 15 });
  });
  it("未知模型（ollama 本地等）→ undefined", () => {
    expect(priceFor("minimax-m3:cloud")).toBeUndefined();
    expect(priceFor("")).toBeUndefined();
  });
});

describe("estimateCostUsd 分段计费", () => {
  const P = 2.5, O = 10; // qwen3.8-flash
  it("纯未缓存：prompt×input + completion×output", () => {
    const c = estimateCostUsd("qwen3.8-flash", { promptTokens: 1_000_000, completionTokens: 500_000 })!;
    expect(c).toBeCloseTo(P + O / 2, 6);
  });
  it("缓存段拆价：read×0.1、write×1.25、剩余未缓存", () => {
    const u = { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 500_000, cacheWriteTokens: 300_000 };
    const c = estimateCostUsd("qwen3.8-flash", u)!;
    expect(c).toBeCloseTo((200_000 * P + 500_000 * P * CACHE_READ_MULT + 300_000 * P * CACHE_WRITE_MULT) / 1e6, 6);
  });
  it("全命中：read=prompt → 成本=0.1x 输入价", () => {
    const c = estimateCostUsd("qwen3.8-flash", { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 1_000_000 })!;
    expect(c).toBeCloseTo(P * CACHE_READ_MULT, 6);
  });
  it("异常数据防御：read+write 超 prompt 时按 prompt 截断，不为负", () => {
    const c = estimateCostUsd("qwen3.8-flash", { promptTokens: 1000, completionTokens: 0, cacheReadTokens: 900, cacheWriteTokens: 5000 })!;
    expect(c).toBeGreaterThanOrEqual(0);
    // read=900 先占，write 截断到剩余 100，未缓存=0
    expect(c).toBeCloseTo((900 * P * 0.1 + 100 * P * 1.25) / 1e6, 5);
  });
  it("未知定价 → undefined（不冒充 0 成本）", () => {
    expect(estimateCostUsd("some-local-model", { promptTokens: 100, completionTokens: 5 })).toBeUndefined();
  });
});
