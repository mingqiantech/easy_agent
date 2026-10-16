import { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "./embedding.js";

export interface OptimizedSearchResult {
  hits: Array<{
    id: number;
    source: string;
    filePath: string;
    excerpt: string;
    score: number;
  }>;
  fromCache: boolean;
  searchTimeMs: number;
}

/**
 * 优化搜索 — 先向量搜索，再全文过滤
 */

export class OptimizedSearch {
  private cache = new Map<string, { result: any[]; timestamp: number }>();
  private cacheTTL = 5 * 60 * 1000; // 缓存时间，单位毫秒

  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
  ) {}

  async search(
    query: string,
    options: { limit?: number; source?: string } = {},
  ): Promise<OptimizedSearchResult> {
    const start = Date.now();
    const limit = options.limit ?? 10;
    const cacheKey = `${query}:${limit}:${options.source ?? "all"}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return {
        hits: cached.result,
        fromCache: true,
        searchTimeMs: Date.now() - start,
      };
    }

    // 向量搜索
    const queryVec = await this.embedding.embed(query);
    let hits: any[] = [];

    try {
      const rows = this.db
        .prepare(
          `
        SELECT m.*, vec_distance_cosine(v.embedding, ?) as distance
        FROM memory_vec v
        JOIN memory_entries m ON v.id = m.id
        ${options.source ? "WHERE m.source = ?" : ""}
        ORDER BY distance ASC
        LIMIT ?
      `,
        )
        .all(
          ...(options.source
            ? [Buffer.from(queryVec.buffer), options.source, limit]
            : [Buffer.from(queryVec.buffer), limit]),
        ) as any[];

      hits = rows.map((r) => ({
        id: r.id,
        source: r.source,
        filePath: r.file_path,
        excerpt: r.excerpt,
        score: 1 - r.distance,
      }));
    } catch {
      // 向量搜索失败，降级为全文搜索
      hits = this.fallbackSearch(query, limit, options.source);
    }

    // 更新缓存
    this.cache.set(cacheKey, { result: hits, timestamp: Date.now() });

    // 清理过期缓存
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.timestamp > this.cacheTTL) this.cache.delete(k);
      }
    }

    return {
      hits,
      fromCache: false,
      searchTimeMs: Date.now() - start,
    };
  }
  private fallbackSearch(query: string, limit: number, source?: string): any[] {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (keywords.length === 0) return [];

    const all = this.db
      .prepare(
        `SELECT * FROM memory_entries ${source ? "WHERE source = ?" : ""}`,
      )
      .all(...(source ? [source] : [])) as any[];

    return all
      .map((entry) => {
        const lower = entry.excerpt.toLowerCase();
        const matchCount = keywords.filter((kw) => lower.includes(kw)).length;
        return {
          id: entry.id,
          source: entry.source,
          filePath: entry.file_path,
          excerpt: entry.excerpt,
          score: matchCount / keywords.length,
        };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
