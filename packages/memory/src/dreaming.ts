import { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ShortTermMemory } from "./short-term.js";

const DAY_MS = 86400000;

const PROMOTION = { minRecallCount: 3, minUniqueQueries: 2, minScore: 0.5 };

const FORGET = {
  shortTermMaxAgeDays: 30,
  shortTermMinRecall: 0,
};

const MEMORY_BUDGET_CHARS = 10000;

export interface DreamingDeps {
  db: Database;
  shortTerm: ShortTermMemory;
  llmGenerate: (prompt: string) => Promise<string>;
  readMemory: () => Promise<string>;
  writeMemory: (content: string) => Promise<void>;
}

export async function lightDream(
  deps: DreamingDeps,
): Promise<{ processed: number; extracted: number }> {
  const now = Date.now();
  deps.db
    .prepare(
      `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('light', ?, '{}', ?)`,
    )
    .run(now, now);
  return { processed: 0, extracted: 0 };
}

export async function remDreaming(
  deps: DreamingDeps,
): Promise<{ candidates: number }> {
  const now = Date.now();
  const entries = deps.shortTerm.getActive();
  const scored = entries.map((e) => ({ ...e, score: calcScore(e, now) }));
  const candidates = scored.filter(
    (e) =>
      e.score >= PROMOTION.minScore &&
      e.recallCount >= PROMOTION.minRecallCount &&
      e.uniqueQueries >= PROMOTION.minUniqueQueries,
  );

  deps.db
    .prepare(
      `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('rem', ?, ?, ?)`,
    )
    .run(now, JSON.stringify({ candidateCount: candidates.length }), now);

  return { candidates: candidates.length };
}

export async function deepDreaming(
  deps: DreamingDeps,
): Promise<{ promoted: number; forgotten: number }> {
  const now = Date.now();
  const entries = deps.shortTerm
    .getActive()
    .map((e) => ({ ...e, score: calcScore(e, now) }))
    .filter(
      (e) =>
        e.score >= PROMOTION.minScore &&
        e.recallCount >= PROMOTION.minRecallCount,
    );
  if (entries.length === 0) {
    return { promoted: 0, forgotten: executeForget(deps, now) };
  }

  const prompt = `将以下记忆整合为简洁的长期记忆段落：\n\n${entries.map((e) => `- ${e.text}`).join("\n")}`;
  const section = await deps.llmGenerate(prompt);
  const current = await deps.readMemory();
  const today = new Date().toISOString().slice(0, 10);
  const final = enforceBudget(
    current + `\n\n## Promoted (${today})\n\n${section}`,
    MEMORY_BUDGET_CHARS,
  );

  await deps.writeMemory(final);

  const update = deps.db.prepare(
    "UPDATE short_term_memory SET promoted_at = ? WHERE id = ?",
  );
  for (const e of entries) update.run(now, e.id);

  const forgotten = executeForget(deps, now);
  deps.db
    .prepare(
      `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('deep', ?, ?, ?)`,
    )
    .run(now, JSON.stringify({ promoted: entries.length, forgotten }), now);

  return { promoted: entries.length, forgotten };
}

function calcScore(entry: any, nowMs: number): number {
  const daysSince =
    (nowMs - (entry.lastRecalledAt ?? entry.createdAt)) / DAY_MS;
  const recency = Math.exp((-0.693 * daysSince) / 14);
  const recallFreq = Math.min(entry.recallCount / 10, 1);
  const queryDiv = Math.min(entry.uniqueQueries / 5, 1);
  const consol = Math.min((entry.recallDays?.length ?? 0) / 5, 1);
  return recency * 0.3 + recallFreq * 0.3 + queryDiv * 0.2 + consol * 0.2;
}

function executeForget(deps: DreamingDeps, nowMs: number): number {
  const cutoff = nowMs - FORGET.shortTermMaxAgeDays * DAY_MS;
  const r = deps.db
    .prepare(
      `
    UPDATE short_term_memory SET forgotten_at = ?
    WHERE promoted_at IS NULL AND forgotten_at IS NULL
      AND created_at < ? AND recall_count <= ?
  `,
    )
    .run(nowMs, cutoff, FORGET.shortTermMinRecall);
  return r.changes;
}

function enforceBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split("\n");
  // 删除最老的 Promoted 段落
  let result = content;
  while (result.length > maxChars) {
    const match = result.match(/## Promoted \(([^)]+)\)/);
    if (!match) break;
    const idx = result.indexOf(match[0]);
    const nextSection = result.indexOf("\n## ", idx + 1);
    if (nextSection === -1) {
      result = result.slice(0, idx).trim();
    } else {
      result = result.slice(0, idx) + result.slice(nextSection);
    }
  }
  if (result.length > maxChars)
    result = result.slice(0, maxChars - 100) + "\n\n...[older entries removed]";
  return result;
}
