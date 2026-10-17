import type { ThinkingLevel } from "@easy-agent/schema/llm";

/**
 * 思考等级 → 各协议参数映射（OpenClaw 式 thinking）
 * off/未配置 → 不发送任何思考参数。
 */

const BUDGETS: Record<"low" | "medium" | "high", number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

/** provider metadata 类型（避免直接依赖 ai-sdk 内部类型，值均为 JSON 安全） */
type ProviderMeta = Record<string, Record<string, any>> | undefined;

/** OpenAI 兼容协议：reasoning_effort 透传 */
export function openaiThinkingOptions(
  thinking?: ThinkingLevel,
): ProviderMeta {
  if (!thinking || thinking === "off") return undefined;
  return { openai: { reasoningEffort: thinking } };
}

/** Anthropic 协议：extended thinking 预算 */
export function anthropicThinkingOptions(
  thinking?: ThinkingLevel,
): ProviderMeta {
  if (!thinking || thinking === "off") return undefined;
  return {
    anthropic: {
      thinking: { type: "enabled", budgetTokens: BUDGETS[thinking] },
    },
  };
}

/** Anthropic 要求 maxTokens > budgetTokens；按需抬高 */
export function anthropicMaxTokens(
  thinking: ThinkingLevel | undefined,
  requested?: number,
): number {
  const base = requested ?? 8192;
  if (!thinking || thinking === "off") return base;
  return Math.max(base, BUDGETS[thinking] + 1024);
}
