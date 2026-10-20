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

/** 轻眠提取提示词：只提值得长记的事，[重要] 前缀的条目直接进晋升候选 */
const LIGHT_PROMPT = `你是记忆提取器。从对话片段中提取值得长期记住的事实（用户偏好、决策、身份信息、经验教训），忽略闲聊、格式说明和一次性任务细节。
每条必须是完整、可独立理解的句子（10~80 字），不要输出 XML 标签、段落标题或方括号标签。
输出格式：每行一条，最多 8 条，以 • 开头；值得立即固化的行加 [重要] 前缀。
没有可提取的内容时只输出：无

对话片段：
`;

/**
 * 浅眠：扫新消息（rowid 游标增量）→ LLM 提取事实 → 写入短期记忆。
 * 这是 Dreaming 闭环的入口：对话→提取→(REM 评分)→深眠晋升 MEMORY.md→下轮 system prompt 注入。
 * LLM 失败时游标不前进，下个周期重试（不丢窗口）。
 */
export async function lightDreaming(
  deps: DreamingDeps,
  opts: { maxMsgs?: number } = {},
): Promise<{ processed: number; extracted: number }> {
  const now = Date.now();
  const persist = (cursor: number, processed: number, extracted: number) =>
    deps.db
      .prepare(
        `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('light', ?, ?, ?)`,
      )
      .run(
        now,
        JSON.stringify({ cursor, processed, extracted }),
        now,
      );

  let cursor = 0;
  try {
    const row = deps.db
      .prepare("SELECT state FROM dreaming_state WHERE phase='light'")
      .get() as any;
    cursor = Number(JSON.parse(row?.state ?? "{}")?.cursor ?? 0);
  } catch {}

  const msgs = deps.db
    .prepare(
      `SELECT rowid AS rid, session_id AS sessionId, role, content FROM messages
       WHERE rowid > ? AND role IN ('user','assistant')
       ORDER BY rowid LIMIT ?`,
    )
    .all(cursor, opts.maxMsgs ?? 300) as any[];
  if (!msgs.length) return { processed: 0, extracted: 0 };
  const maxRid = msgs[msgs.length - 1].rid as number;

  const snippets: string[] = [];
  for (const m of msgs) {
    let text = String(m.content ?? "").trim();
    // assistant 历史可能存的是 {text,toolCalls} JSON，取纯文本
    if (m.role === "assistant") {
      try {
        const p = JSON.parse(text);
        if (p && typeof p === "object") text = String(p.text ?? "").trim();
      } catch {}
    }
    if (!text || text.startsWith("【摘要】") || text.startsWith("【系统恢复】")) continue;
    if (text.length < 12 || text.length > 600) continue;
    snippets.push(`[${m.role}] ${text.slice(0, 400)}`);
  }

  if (!snippets.length) {
    persist(maxRid, msgs.length, 0);
    return { processed: msgs.length, extracted: 0 };
  }

  let extracted = 0;
  const out = await deps.llmGenerate(LIGHT_PROMPT + snippets.join("\n"));
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim().replace(/^[•\-*+\d.、\s]+/, "").trim();
    if (!line || /^无[。.]?$/.test(line)) continue;
    const important = line.startsWith("[重要]");
    const fact = line.replace(/^\[重要\]\s*/, "").trim();
    // 质量闸门：要求完整句子；丢弃 XML 标签碎片和纯标题式短语
    if (fact.length < 10 || fact.length > 200) continue;
    if (/[<>]/.test(fact)) continue;
    if (/^[【\[(（].*[】\])）]$/.test(fact)) continue;
    const origin = `light:msg#${maxRid}`;
    if (important) deps.shortTerm.addImportant(fact, origin);
    else deps.shortTerm.add(fact, origin);
    extracted++;
  }

  persist(maxRid, msgs.length, extracted);
  return { processed: msgs.length, extracted };
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
