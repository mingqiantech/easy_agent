import { describe, it, expect } from "bun:test";
import {
  openaiThinkingOptions,
  anthropicThinkingOptions,
  anthropicMaxTokens,
} from "../src/thinking.js";

describe("thinking 参数映射（OpenClaw 式思考等级）", () => {
  it("off / 未配置 → 不发送任何思考参数", () => {
    expect(openaiThinkingOptions(undefined)).toBeUndefined();
    expect(openaiThinkingOptions("off")).toBeUndefined();
    expect(anthropicThinkingOptions(undefined)).toBeUndefined();
    expect(anthropicThinkingOptions("off")).toBeUndefined();
    expect(anthropicMaxTokens("off", 5000)).toBe(5000);
    expect(anthropicMaxTokens(undefined)).toBe(8192);
  });

  it("openai 协议映射 reasoning_effort", () => {
    expect(openaiThinkingOptions("low")).toEqual({
      openai: { reasoningEffort: "low" },
    });
    expect(openaiThinkingOptions("high")).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it("anthropic 协议映射 thinking.budget_tokens", () => {
    expect(anthropicThinkingOptions("low")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
    });
    expect(anthropicThinkingOptions("medium")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
    expect(anthropicThinkingOptions("high")).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
    });
  });

  it("anthropic maxTokens 必须大于预算：自动抬高", () => {
    expect(anthropicMaxTokens("low")).toBe(8192); // 8192 > 1024+1024? = 2048 → 保留 8192
    expect(anthropicMaxTokens("medium")).toBe(8192); // 4096+1024=5120 < 8192
    expect(anthropicMaxTokens("high")).toBe(9216); // 8192+1024 > 8192 → 抬高
    expect(anthropicMaxTokens("high", 20000)).toBe(20000); // 用户指定更大则尊重
  });
});
