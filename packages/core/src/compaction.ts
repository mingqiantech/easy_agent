import type { LLMClient } from "@easy-agent/llm/client";
import type { Message } from "@easy-agent/schema/llm";

const MAX_MESSAGES = 50; // 超过这个数触发压缩
const KEEP_RECENT = 10; // 保留最近 N 条
const MAX_TOKENS = 8000; // 估算 token 上限

export interface CompactionResult {
  compacted: Message[]; // 压缩后的消息列表
  summary: string; // 压缩摘要
  removed: number; // 移除的消息数
}

/**
 * 检查是否需要压缩
 */
export function needsCompaction(messages: Message[]): boolean {
  if (messages.length < MAX_MESSAGES) return false;
  const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
  return totalChars > MAX_TOKENS * 4; // 粗略估算 1 token ≈ 4 chars
}

/**
 * 执行压缩
 *
 * 策略：
 * 1. 保留系统消息和最近 KEEP_RECENT 条
 * 2. 中间的消息用 LLM 生成摘要
 * 3. 摘要作为新的系统消息
 */
export async function compactHistory(
  llm: LLMClient,
  model: string,
  messages: Message[],
): Promise<CompactionResult> {
  // 分离系统消息
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  if (conversation.length <= KEEP_RECENT) {
    return { compacted: messages, summary: "", removed: 0 };
  }

  // 要压缩的部分
  const toCompact = conversation.slice(0, -KEEP_RECENT);
  const toKeep = conversation.slice(-KEEP_RECENT);

  // 用 LLM 生成摘要
  const compactText = toCompact
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");

  const response = await llm.generate({
    model,
    system:
      "你是对话摘要助手。将以下对话历史压缩为简洁的摘要，保留关键信息、决策、待办事项。用中文输出。",
    messages: [{ role: "user", content: compactText }],
    generation: { maxTokens: 1000 },
  });

  // 构建压缩后的消息列表
  const summaryMessage: Message = {
    role: "system",
    content: `[对话摘要]\n${response.content}`,
  };

  return {
    compacted: [...systemMsgs, summaryMessage, ...toKeep],
    summary: response.content,
    removed: toCompact.length,
  };
}
