import type { EmbeddingProvider } from "./embedding.js";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { MemorySearcher, SearchHit } from "./search.js";
import type { FtsIndex } from "./fts.js";
import type { VecIndex } from "./vec.js";

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
    private fts?: FtsIndex,
    private vec?: VecIndex,
    /** 索引所在库；缺省 getDatabase 单例（生产同库，测试必须显式传入） */
    private database?: Database,
  ) {}

  async search(
    query: string,
    options: HybridSearchOptions = {},
  ): Promise<{ hits: HybridHit[]; mode: "hybrid" | "text-only" }> {
    const limit = options.limit ?? 10;
    const vw = options.vectorWeight ?? 0.7;
    const tw = options.textWeight ?? 0.3;

    // 1. 关键词通道：FTS5 BM25 优先（索引存在时），退回文件行扫描
    const src = options.source === "session" ? "session" : "memory";
    let textHits: SearchHit[] = [];
    if (this.fts?.ok) {
      textHits = this.fts
        .search(query, { limit: limit * 3, source: src })
        .map((h) => ({
          path: h.path,
          excerpt: h.excerpt,
          score: h.score,
          source: src as SearchHit["source"],
        }));
      // BM25 命中同样喂 Dreaming recall 统计（与文件扫描通道行为对齐）
      if (textHits.length && this.textSearcher.onHit) {
        for (const h of textHits.slice(0, limit)) {
          try {
            this.textSearcher.onHit(
              this.workDir ? path.join(this.workDir, h.path) : h.path,
            );
          } catch {}
        }
      }
    }
    if (!textHits.length) {
      const textResult = await this.textSearcher.search(query, {
        maxResults: limit * 3,
        corpus: options.source === "session" ? "sessions" : "memory",
      });
      textHits = textResult.hits ?? [];
    }

    // 2. 向量通道（可选）
    let vectorHits: Array<{ key: string; score: number; excerpt: string; path: string }> = [];
    if (this.embedding) {
      try {
        vectorHits = await this.vectorSearch(
          query,
          limit * 3,
          src,
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
        source: src,
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
    const db = this.database ?? this.vec?.db ?? getDatabase();
    const embedding = this.embedding!;
    const queryVec = await embedding.embed(query);

    // 优先 sqlite-vec KNN（库内 TopK，不扫全表）
    if (this.vec?.available) {
      const knn = this.vec.search(queryVec, limit, source);
      if (knn && knn.length) {
        const getInfo = db.prepare(
          "SELECT file_path AS path, excerpt FROM memory_entries WHERE id = ?",
        );
        const out: Array<{ key: string; score: number; excerpt: string; path: string }> = [];
        for (const r of knn) {
          const info = getInfo.get(r.id) as any;
          if (!info) continue;
          out.push({ key: String(r.id), score: r.score, excerpt: info.excerpt, path: info.path });
        }
        if (out.length) return out;
      }
    }

    // 退回：暴力扫 memory_vec BLOB（小数据量或扩展不可用）
    const rows = db
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
