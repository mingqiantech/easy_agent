import type { HybridSearch } from "@easy-agent/memory/hybrid-search";

/**
 * 检索式记忆 provider（2026-11-11）：用户问题 → 从混合索引（记忆文件+会话语料）
 * 捞 topK 相关片段，拼成注入文本。配合 session.run 的 recallNote——
 * 片段作临时 system 挂在请求**末尾**（纯追加），不进历史、不动缓存前缀。
 * 会话归档出窗口的老消息经摄取进 session-corpus，正是这里的主猎场：
 * 「和上下文没牵扯的问题」需要的旧信息不再靠全量重放，按需付费。
 */

export interface RecallCfg {
  topK?: number;
  minScore?: number;
  maxChars?: number;
}

const PER_EXCERPT_CHARS = 400;

export function buildRecallNote(
  hits: Array<{ combinedScore: number; excerpt: string; path: string }>,
  cfg: { topK: number; minScore: number; maxChars: number },
): string | null {
  const picked = hits
    .filter((h) => h.combinedScore >= cfg.minScore)
    .slice(0, cfg.topK);
  if (!picked.length) return null;
  const lines: string[] = [];
  let budget = cfg.maxChars;
  for (const [i, h] of picked.entries()) {
    const text = String(h.excerpt ?? "")
      .replace(/\s+/g, " ")
      .slice(0, Math.min(PER_EXCERPT_CHARS, budget))
      .trim();
    if (!text) continue;
    const line = `${i + 1}. (相关度 ${h.combinedScore.toFixed(2)}｜${h.path.split("/").slice(-2).join("/")}) ${text}`;
    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.push(line);
  }
  if (!lines.length) return null;
  return (
    `【检索片段】系统按本轮问题从你的历史记忆/会话归档中捞回以下片段（相关度降序）。` +
    `与问题无关就整段忽略；有关就直接采用其中事实，但别向用户复述本段来源格式：\n` +
    lines.join("\n")
  );
}

export function createRecallProvider(
  hybridFor: (agentId?: string) => HybridSearch | undefined,
  cfg: RecallCfg,
  log: (msg: string) => void = () => {},
): (text: string, agentId?: string) => Promise<string | null> {
  const conf = {
    topK: cfg.topK ?? 3,
    minScore: cfg.minScore ?? 0.35,
    maxChars: cfg.maxChars ?? 1600,
  };
  return async (text: string, agentId?: string) => {
    const hybrid = hybridFor(agentId);
    if (!hybrid) return null;
    try {
      // 查询词太短（单字/寒暄）不值得捞
      if (text.trim().length < 2) return null;
      const { hits } = await hybrid.search(text, { limit: conf.topK * 3 });
      const note = buildRecallNote(hits as any, conf);
      if (note) log(`🧠 recall 注入: agent=${agentId ?? "default"} 命中 ${hits.length}→${conf.topK}`);
      return note;
    } catch (e: any) {
      log(`🧠 recall 检索失败（跳过注入）: ${String(e?.message).slice(0, 120)}`);
      return null;
    }
  };
}
