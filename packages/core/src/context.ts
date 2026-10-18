import type { Message } from "@easy-agent/schema/llm";

/**
 * 上下文瘦身（OpenClaw 式上下文工程）：
 * - 超过 keepLast 的旧工具结果换成短 stub——模型只需要知道"调过、大致结果"，
 *   不需要每次都重读全部历史输出（token 消耗大头）
 * - 单条消息超过 maxChars 截断加省略标记
 * 注意：只作用于发给 LLM 的副本，数据库存储保持完整。
 */
export function pruneToolResults(
  messages: Message[],
  opts?: { keepLast?: number; maxChars?: number },
): Message[] {
  const keepLast = opts?.keepLast ?? 6;
  const maxChars = opts?.maxChars ?? 8000;
  const toolIdx = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  const prunable = new Set(
    toolIdx.slice(0, Math.max(0, toolIdx.length - keepLast)),
  );
  return messages.map((m, i) => {
    if (m.role === "tool" && prunable.has(i)) {
      const head = m.content.slice(0, 80).replace(/\s+/g, " ");
      return { ...m, content: `[旧工具结果已修剪 ${m.content.length} 字] ${head}…` };
    }
    if (m.content.length > maxChars) {
      return {
        ...m,
        content: m.content.slice(0, maxChars) + "\n…[截断]",
      };
    }
    return m;
  });
}
