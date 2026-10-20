import type { EmbeddingProvider } from "./embedding.js";
import type { MemorySearcher, SearchHit } from "./search.js";

export interface HybridHit {
  path: string;
  excerpt: string;
  source: string;
  vectorScore: number;
  textScore: number;
  combinedScore: number;
}

export interface HybridSearchOptions {
  limit?: number;
  /** 向量权重（默认 0.7） */
  vectorWeight?: number;
  /** 全文权重（默认 0.3） */
  textWeight?: number;
  source?: "memory" | "session";
}

/**
 * 混合搜索（Week 11）
 *
 * 向量相似度捕捉语义（"汽车"≈"车辆"），全文匹配保证精确词命中，
 * 两路结果融合加权排序。向量不可用时自动退化为纯文本。
 */
export class HybridSearch {
  constructor(
    private textSearcher: MemorySearcher,
    private embedding?: EmbeddingProvider,
    /** 命中路径归一化用（相对工作区），与文本通道一致 */
    private workDir?: string,
  ) {}

  async search(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<{ hits: HybridHit[]; mode: "hybrid" | "text-only" }> {
    const limit = options.limit ?? 10;
    const vw = options.vectorWeight ?? 0.7;
    const tw = options.textWeight ?? 0.3;

    // 1. 全文通道
    const textResult = await this.textSearcher.search(query, {
      maxResults: limit * 3,
      corpus: options.source === "session" ? "sessions" : "memory",
    });
    const textHits: SearchHit[] = textResult.hits ?? [];

    // 2. 向量通道（可选）
    let vectorHits: Array<{ key: string; score: number; excerpt: string; path: string }> = [];
    if (this.embedding) {
      try {
        vectorHits = await this.vectorSearch(
          query,
          limit * 3,
          options.source === "session" ? "session" : "memory",
        );
      } catch {
        vectorHits = [];
      }
    }

    const mode = vectorHits.length > 0 && this.embedding ? "hybrid" : "text-only";

    // 3. 融合：用 path+excerpt 前缀做对齐键
    const byKey = new Map<string, HybridHit>();
    const keyOf = (path: string, excerpt: string) => `${path}::${excerpt.slice(0, 40)}`;

    for (const h of vectorHits) {
      const rel = this.workDir && h.path.startsWith(this.workDir)
        ? h.path.slice(this.workDir.length + 1)
        : h.path;
      byKey.set(keyOf(rel, h.excerpt), {
        path: rel,
        excerpt: h.excerpt,
        source: options.source === "session" ? "session" : "memory",
        vectorScore: h.score,
        textScore: 0,
        combinedScore: 0,
      });
    }
    for (const h of textHits) {
      const excerpt = h.excerpt ?? "";
      const k = keyOf(h.path, excerpt);
      const existing = byKey.get(k);
      if (existing) existing.textScore = h.score;
      else
        byKey.set(k, {
          path: h.path,
          excerpt,
          source: h.source ?? "memory",
          vectorScore: 0,
          textScore: h.score,
          combinedScore: 0,
        });
    }

    const combined = Array.from(byKey.values()).map((h) => ({
      ...h,
      combinedScore: h.vectorScore * vw + h.textScore * tw,
    }));

    combined.sort((a, b) => b.combinedScore - a.combinedScore);
    return { hits: combined.slice(0, limit), mode };
  }

  /**
   * 向量通道：query 算一次 embedding，与 memory_vec 预存向量逐一余弦。
   * 无预存向量的条目跳过（首次索引完成前自动退化为 text-only）。
   */
  private async vectorSearch(query: string, limit: number, source?: string) {
    const { getDatabase } = await import("@easy-agent/core/database");
    const embedding = this.embedding!;
    const queryVec = await embedding.embed(query);

    const rows = getDatabase()
      .prepare(
        `SELECT e.id, e.file_path AS path, e.excerpt AS excerpt, v.embedding AS blob
         FROM memory_entries e JOIN memory_vec v ON v.id = e.id
         WHERE e.source = ?`,
      )
      .all(source ?? "memory") as any[];

    const scored: Array<{ key: string; score: number; excerpt: string; path: string }> = [];
    for (const r of rows) {
      const vec = new Float32Array(r.blob.buffer, r.blob.byteOffset, r.blob.byteLength / 4);
      // 维度不一致（换过 embedding 模型）→ 跳过，交给重索引修复
      if (vec.length !== queryVec.length) continue;
      scored.push({ key: String(r.id), score: cosine(queryVec, vec), excerpt: r.excerpt, path: r.path });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
