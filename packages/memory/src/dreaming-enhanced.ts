import type { Database } from "bun:sqlite";
import type { ShortTermMemory } from "./short-term.js";

const DAY_MS = 86400000;

export interface EnhancedDreamingDeps {
  db: Database;
  shortTerm: ShortTermMemory;
  llmGenereate: (prompt: string, system?: string) => Promise<string>;
  readMemory: () => Promise<string>;
  writeMemory: (content: string) => Promise<void>;
}

/**
 * 增强版 Dreaming Pipeline
 *
 * 改进：
 * 1. 分类巩固（不同类型的信息分别处理）
 * 2. 去重（相似的条目合并）
 * 3. 关联（找到记忆之间的关联）
 */
export async function enhancedDreaming(deps: EnhancedDreamingDeps): promise<{
  progress: number;
  promoted: number;
  forgotten: number;
  deduplicated: number;
}> {
  const now = Date.now();
  const entries = deps.shortTerm.getActive();

  if (entries.length === 0) {
    return {
      process: 0,
      promoted: 0,
      forgotten: executeForget(deps, now),
      deduplicated: 0,
    };
  }

  // 1. 去重：用 LLM 识别相似的条目
  const dedupResult = await deduplicateEntries(deps, entries);
  const uniqueEntries = dedupResult.unique;

  // 2. 分类：将条目按类型分组
  const classified = await classifyEntries(deps, uniqueEntries);
}
