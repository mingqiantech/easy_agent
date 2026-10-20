import { Database } from "bun:sqlite";
import { tokenizeQuery } from "./search.js";

/**
 * FTS5 全文索引（BM25）——混合检索的关键词通道。
 *
 * 中文分词策略：索引与查询两侧都用 tokenizeQuery 的 bigram 切词，
 * 把 "视频生成" 变成 "视 频 生 成 视频 频生 生成…" 空格连接后入 FTS，
 * 借用 unicode61 默认切分实现中文子串级匹配。
 */
export interface FtsHit {
  path: string;
  excerpt: string;
  score: number; // 归一化 0~1
}

/** 文档/查询共用的分词串 */
export function ftsTokens(text: string): string {
  return tokenizeQuery(text).join(" ");
}

export class FtsIndex {
  private available = false;

  constructor(private db: Database) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
           path, tokens, excerpt UNINDEXED
         )`,
      );
      this.available = true;
    } catch {
      // 引擎不支持 FTS5 → 检索自动退回文件扫描
    }
  }

  get ok(): boolean {
    return this.available;
  }

  /** 替换某文件的全部 FTS 块（chunk 与 memory_entries.id 对齐，rowid 复用） */
  indexChunks(
    relPath: string,
    items: Array<{ id: number; excerpt: string }>,
  ): void {
    if (!this.available) return;
    const del = this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?");
    const ins = this.db.prepare(
      "INSERT INTO memory_fts (rowid, path, tokens, excerpt) VALUES (?, ?, ?, ?)",
    );
    const run = this.db.transaction(() => {
      for (const it of items) {
        del.run(it.id);
        ins.run(it.id, relPath, ftsTokens(it.excerpt), it.excerpt);
      }
    });
    try {
      run();
    } catch {
      // 单文件写入失败不影响整体
    }
  }

  removeIds(ids: number[]): void {
    if (!this.available || !ids.length) return;
    const del = this.db.prepare("DELETE FROM memory_fts WHERE rowid = ?");
    for (const id of ids) del.run(id);
  }

  clearAll(): void {
    if (!this.available) return;
    try {
      this.db.exec("DELETE FROM memory_fts");
    } catch {}
  }

  /** BM25 检索；match 语法自动转 bigram OR 查询 */
  search(
    query: string,
    opts: { limit?: number; source?: string } = {},
  ): Array<FtsHit & { ts?: number }> {
    if (!this.available) return [];
    const tokens = tokenizeQuery(query);
    if (!tokens.length) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    const limit = opts.limit ?? 10;
    try {
      const rows = (opts.source
        ? this.db
            .prepare(
              `SELECT f.path AS path, f.excerpt AS excerpt, -bm25(memory_fts) AS score, e.updated_at AS ts
               FROM memory_fts f JOIN memory_entries e ON e.id = f.rowid
               WHERE memory_fts MATCH ? AND e.source = ?
               ORDER BY score DESC LIMIT ?`,
            )
            .all(match, opts.source, limit)
        : this.db
            .prepare(
              `SELECT path, excerpt, -bm25(memory_fts) AS score
               FROM memory_fts WHERE memory_fts MATCH ?
               ORDER BY score DESC LIMIT ?`,
            )
            .all(match, limit)) as any[];

      if (!rows.length) return [];
      const max = Math.max(...rows.map((r) => Number(r.score)), 0.000001);
      return rows.map((r) => ({
        path: String(r.path),
        excerpt: String(r.excerpt),
        ts: Number(r.ts) || undefined,
        score: Math.min(1, Math.max(0.05, Number(r.score) / max)), // 顶部归一，保相对序
      }));
    } catch {
      return [];
    }
  }
}
