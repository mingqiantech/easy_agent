import type { Message } from "@easy-agent/schema/llm";

/**
 * 上下文瘦身（OpenClaw 式上下文工程）：
 * - 超过 keepLast 的旧工具结果换成短 stub——模型只需要知道"调过、大致结果"，
 *   不需要每次都重读全部历史输出（token 消耗大头）
 * - 单条消息超过 maxChars 截断加省略标记
 * 注意：只作用于发给 LLM 的副本，数据库存储保持完整。
 *
 * 缓存经济学（2026-10-29 二次修正，推翻 10-22 结论）：10-22 认为「跨界 stub 很短、
 * 影响微乎其实」是错的——代价不在 stub 本身大小，而在**改写发生在已缓存前缀的中部**：
 * 滑动窗口每右移一格，那条消息之后的全部历史（最近 keepLast 条完整结果+穿插文本，
 * 实测 11-13k token）缓存作废、按全价重写。用量表实测：调用间隔 <1min 仍有 34% 重写率，
 * 就是这个每轮必发的边界抖动。
 * 解法：量化水位线批量修剪——修剪条数按 keepLast 整数倍随历史单调上移，
 * 完整尾巴在 keepLast~keepLast*batch（默认 2 倍）间浮动。平时纯追加（新尾巴
 * 125% 写一次、旧前缀 10% 读），前缀失效从每轮一次降到每 keepLast 轮一次。
 * 多出来的全文旧结果都在已缓存前缀里，读价 10%，比缓存作废便宜得多。
 */
/** 轮首水位快照：当前消息集下 pruneToolResults 会修剪的条数（供调用方冻结传入） */
export function pruneWatermark(messages: Message[], keepLast = 6): number {
  const batch = Math.max(
    1,
    Number(process.env.EASY_AGENT_PRUNE_BATCH ?? 2) || 2,
  );
  const toolCount = messages.filter((m) => m.role === "tool").length;
  if (keepLast <= 0) return toolCount;
  return Math.max(
    0,
    Math.min(
      toolCount - keepLast,
      keepLast * Math.floor(Math.max(0, toolCount - keepLast) / (keepLast * batch)),
    ),
  );
}

export function pruneToolResults(
  messages: Message[],
  opts?: { keepLast?: number; maxChars?: number; pruneCount?: number },
): Message[] {
  // 批量因子（额外窗口倍数）：完整尾巴允许在 keepLast ~ keepLast*batch 间浮动，
  // env 可调（测试/调优用）；1 ≈ 逐轮滑动（每轮多 1 条完整就修剪）
  const batch = Math.max(
    1,
    Number(process.env.EASY_AGENT_PRUNE_BATCH ?? 2) || 2,
  );
  const keepLast = opts?.keepLast ?? 6;
  const maxChars = opts?.maxChars ?? 8000;
  const toolIdx = messages
    .map((m, i) => (m.role === "tool" ? i : -1))
    .filter((i) => i >= 0);
  // 量化水位线：修剪条数只能是 keepLast 的整数倍，随工具结果总数单调不降——
  // 两次跳变之间的追加不改变任何旧消息（前缀冻结，缓存持续命中）；
  // keepLast=0 特殊：每轮全修剪（调用方显式要求，不管稳定性）
  // opts.pruneCount：调用方冻结的水位（轮首快照，工具循环内不随新结果摆动）
  const pruneCount =
    opts?.pruneCount ??
    (keepLast <= 0
      ? toolIdx.length
      : Math.min(
          toolIdx.length - keepLast,
          keepLast * Math.floor(Math.max(0, toolIdx.length - keepLast) / (keepLast * batch)),
        ));
  const prunable = new Set(toolIdx.slice(0, Math.max(0, Math.min(pruneCount, toolIdx.length))));
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
