import { Database } from "bun:sqlite";
import { ulid } from "ulid";

export interface ShortTermEntry {
  id: string;
  text: string;
  origin: string | null;
  recallCount: number;
  uniqueQueries: number;
  recallDays: string[];
  lastRecalledAt: number | null;
  createdAt: number;
  promotedAt: number | null;
  forgottenAt: number | null;
}

export class ShortTermMemory {
  constructor(private db: Database) {}

  add(text: string, origin?: string): string {
    const id = ulid();
    this.db
      .prepare(
        `
      INSERT INTO short_term_memory (id, text, origin, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(id, text, origin ?? null, Date.now());
    return id;
  }

  /**
   * 重要事实：直接满足晋升门槛（recall/unique 预热），不等被检索命中。
   * 轻眠（lightDreaming）提取时标 [重要] 的条目走这里，形成提取→晋升闭环。
   */
  addImportant(text: string, origin?: string): string {
    const id = ulid();
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        `
      INSERT INTO short_term_memory (id, text, origin, recall_count, unique_queries,
        recall_days, last_recalled_at, created_at)
      VALUES (?, ?, ?, 3, 2, ?, ?, ?)
    `,
      )
      .run(id, text, origin ?? null, JSON.stringify([today]), now, now);
    return id;
  }

  getActive(): ShortTermEntry[] {
    return this.db
      .prepare(
        `
      SELECT id, text, origin, recall_count as recallCount,
             unique_queries as uniqueQueries, recall_days as recallDays,
             last_recalled_at as lastRecalledAt, created_at as createdAt,
             promoted_at as promotedAt, forgotten_at as forgottenAt
      FROM short_term_memory
      WHERE promoted_at IS NULL AND forgotten_at IS NULL
      ORDER BY created_at DESC
    `,
      )
      .all()
      .map((r: any) => ({
        ...r,
        recallDays: JSON.parse(r.recallDays || "[]"),
      }));
  }

  incrementRecall(filePath: string): void {
    const today = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    this.db
      .prepare(
        `
      UPDATE short_term_memory
      SET recall_count = recall_count + 1,
          last_recalled_at = ?,
          recall_days = CASE
            WHEN recall_days NOT LIKE ? THEN json_insert(recall_days, '$[#]', ?)
            ELSE recall_days
          END,
          unique_queries = CASE
            WHEN recall_count > 0 THEN unique_queries + 1
            ELSE unique_queries
          END
      WHERE origin LIKE ?
        AND promoted_at IS NULL AND forgotten_at IS NULL
    `,
      )
      .run(now, `%${today}%`, today, `%${filePath}%`);
  }

  count(): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) as c FROM short_term_memory WHERE promoted_at IS NULL AND forgotten_at IS NULL",
      )
      .get() as any;
    return r?.c ?? 0;
  }
}
