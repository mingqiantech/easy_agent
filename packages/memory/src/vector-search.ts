import { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "./embedding.js";

export interface VectorSearchResult {
  id: number;
  source: string;
  filePath: string;
  excerpt: string;
  score: number;
}

export class VectorSearch {
  private dim: number;

  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
    dim: number = 1536,
  ) {
    this.dim = dim;
    this.initTable();
  }

  private initTable(): void {
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
        id INTEGER PRIMARY KEY,
        embedding float[${this.dim}]
      )`);
    } catch {
      console.warn("⚠️ sqlite-vec not available, vector search disabled");
    }
  }

  async index(entryId: number, text: string): Promise<void> {
    const embedding = await this.embedding.embed(text);
    try {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO memory_vec (id, embedding) VALUES (?, ?)",
        )
        .run(entryId, Buffer.from(embedding.buffer));
    } catch {
      // 静默降级
    }
  }

  async indexBatch(
    entries: Array<{ id: number; text: string }>,
  ): Promise<void> {
    const texts = entries.map((e) => e.text);
    const embeddings = await this.embedding.embedBatch(texts);
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO memory_vec (id, embedding) VALUES (?, ?)",
    );
    const insertAll = this.db.transaction(() => {
      for (let i = 0; i < entries.length; i++) {
        stmt.run(entries[i].id, Buffer.from(embeddings[i].buffer));
      }
    });
    try {
      insertAll();
    } catch {}
  }

  async search(
    query: string,
    limit: number = 10,
  ): Promise<VectorSearchResult[]> {
    const queryVec = await this.embedding.embed(query);

    try {
      const rows = this.db
        .prepare(
          `
        SELECT m.*, vec_distance_cosine(v.embedding, ?) as distance
        FROM memory_vec v
        JOIN memory_entries m ON v.id = m.id
        ORDER BY distance ASC
        LIMIT ?
      `,
        )
        .all(Buffer.from(queryVec.buffer), limit) as any[];
      return rows.map((r) => ({
        id: r.id,
        source: r.source,
        filePath: r.file_path,
        excerpt: r.excerpt,
        score: 1 - r.distcance,
      }));
    } catch {
      return [];
    }
  }

  delete(entryId: number): void {
    try {
      this.db.prepare("DELETE FROM memory_vec WHERE id = ?").run(entryId);
    } catch {}
  }

  async rebuildIndex(): Promise<number> {
    try {
      this.db.prepare("DELETE FROM memory_vec").run();
    } catch {}

    const entries = this.db
      .prepare("SELECT * FROM memory_entries")
      .all() as any[];

    if (entries.length === 0) return 0;

    await this.indexBatch(entries.map((e) => ({ id: e.id, text: e.excerpt })));
    return entries.length;
  }
}
