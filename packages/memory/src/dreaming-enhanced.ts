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

  // 3. 为每类生成整合后的记忆段落
  const sections: string[] = [];
  for (const [category, items] of Object.entries(classified)) {
    if (items.length === 0) continue;
    const prompt = `将以下${category}类记忆整合为简洁段落：
${items.map((e) => `- ${e.text}`).join("\n")}`;
    const summary = await deps.llmGenerate(prompt);
    sections.push(`### ${category}\n\n${summary}`);
  }

  // 4. 读取当前 MEMORY.md
  const current = await deps.readMemory();
  const today = new Date().toISOString().slice(0, 10);
  const newSection = `\n\n## Promoted (${today})\n\n${sections.join("\n\n")}`;

  // 5. 预算控制
  const final = enforceBudget(current + newSection, 10000);
  await deps.writeMemory(final);

  // 6. 标记已提升
  const update = deps.db.prepare(
    "UPDATE short_term_memory SET promoted_at = ? WHERE id = ?",
  );
  for (const e of uniqueEntries) update.run(now, e.id);

  // 7. 遗忘
  const forgotten = executeForget(deps, now);

  return {
    processed: entries.length,
    promoted: uniqueEntries.length,
    forgotten,
    deduplicated: dedupResult.duplicatesRemoved,
  };
}

/**
 * 去重：用 LLM 识别和合并相似的短期记忆条目
 */
async function deduplicateEntries(deps: EnhancedDreamingDeps, entries: any[]) {
  if (entries.length < 2) return { unique: entries, duplicatesRemoved: 0 };

  const text = entries.map((e, i) => `[${i}] ${e.text}`).join("\n");
  const result = await deps.llmGenerate(
    `以下是多个短期记忆条目。找出语义重复或高度相似的条目，合并为去重后的列表。
输出 JSON：{"duplicates": [[0, 3], [1, 5]], "merge": {"0": "合并后的文本"}}

条目：
${text}`,
    "你是一个记忆去重助手。只输出 JSON。",
  );

  try {
    const parsed = JSON.parse(result);
    // 保留每组的第一个，删除其他
    const toDelete = new Set<number>();
    for (const group of parsed.duplicates ?? []) {
      for (let i = 1; i < group.length; i++) toDelete.add(group[i]);
    }
    const unique = entries.filter((_, i) => !toDelete.has(i));
    return { unique, duplicatesRemoved: toDelete.size };
  } catch {
    return { unique: entries, duplicatesRemoved: 0 };
  }
}

/**
 * 分类：将条目分为不同类别
 */
async function classifyEntries(deps: EnhancedDreamingDeps, entries: any[]) {
  const text = entries.map((e, i) => `[${i}] ${e.text}`).join("\n");
  const result = await deps.llmGenerate(
    `将以下记忆条目分类。类别：决策(decisions)、偏好(preferences)、事实(facts)、待办(todos)、人物(people)、项目(projects)。
输出 JSON：{"decisions": [0, 2], "preferences": [1], ...}

条目：
${text}`,
    "你是记忆分类助手。只输出 JSON。",
  );

  const categories: Record<string, any[]> = {
    decisions: [],
    preferences: [],
    facts: [],
    todos: [],
    people: [],
    projects: [],
  };

  try {
    const parsed = JSON.parse(result);
    for (const [cat, indices] of Object.entries(parsed)) {
      if (categories[cat]) {
        for (const idx of indices as number[]) {
          if (entries[idx]) categories[cat].push(entries[idx]);
        }
      }
    }
  } catch {
    categories.facts = entries; // 分类失败，全部归为 facts
  }

  return categories;
}

function executeForget(deps: EnhancedDreamingDeps, nowMs: number): number {
  const cutoff = nowMs - 30 * DAY_MS;
  const r = deps.db
    .prepare(
      `
    UPDATE short_term_memory SET forgotten_at = ?
    WHERE promoted_at IS NULL AND forgotten_at IS NULL
      AND created_at < ? AND recall_count = 0
  `,
    )
    .run(nowMs, cutoff);
  return r.changes;
}

function enforceBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  // 删除最老的 Promoted 段落
  const lines = content.split("\n");
  let result = content;
  while (result.length > maxChars) {
    const match = result.match(/## Promoted \(([^)]+)\)/);
    if (!match) break;
    const idx = result.indexOf(match[0]);
    const nextSection = result.indexOf("\n## ", idx + 1);
    result =
      nextSection === -1
        ? result.slice(0, idx).trim()
        : result.slice(0, idx) + result.slice(nextSection);
  }
  if (result.length > maxChars)
    result = result.slice(0, maxChars - 100) + "\n\n...[older entries removed]";
  return result;
}
