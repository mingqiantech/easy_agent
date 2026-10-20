import { Database } from "bun:sqlite";
import type { EmbeddingProvider } from "./embedding.js";
import { FtsIndex } from "./fts.js";

export class IncrementalIndex {
  private dim: number;
  readonly fts: FtsIndex;

  constructor(
    private db: Database,
    private embedding: EmbeddingProvider,
    dim: number = 1536,
    /** embedding 指纹（如 "ollama:bge-m3"）；变更时全量重建向量+FTS */
    private providerTag: string = "simple",
  ) {
    this.dim = dim;
    this.fts = new FtsIndex(db);
    this.initTable();
    this.ensureFingerprint();
  }

  /**
   * provider/模型切换检测：旧向量维度与新模型不符会全部作废（OpenClaw 同策略）。
   * 指纹存 meta.embedding_fingerprint，不符 → 清空重建。
   */
  private ensureFingerprint(): void {
    const cur = this.db
      .prepare("SELECT value FROM meta WHERE key='embedding_fingerprint'")
      .get() as any;
    if (cur?.value === this.providerTag) return;
    this.db.prepare("DELETE FROM memory_vec").run();
    this.db.prepare("DELETE FROM memory_entries").run();
    this.fts.clearAll();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_fingerprint', ?)",
      )
      .run(this.providerTag);
    if (cur?.value)
      console.log(`🧠 embedding 指纹变更 ${cur.value} → ${this.providerTag}，索引已清空待重建`);
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        file_path TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_entries(file_path);
      CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_entries(source);
    `);
  }

  async indexFile(
    filePath: string,
    source: "memory" | "session" | "wiki",
    /** FTS path 列存的展示路径（缺省用 filePath 本身） */
    displayPath?: string,
  ): Promise<number> {
    const content = await Bun.file(filePath).text();
    const hash = await this.hash(content);

    // 检查已索引且内容未变
    const existing = this.db
      .prepare(
        "SELECT content_hash FROM memory_entries WHERE file_path = ? LIMIT 1",
      )
      .get(filePath) as any;

    if (existing?.content_hash === hash) return 0;

    if (existing) {
      // 多块文件：清齐该文件所有 vec/fts 行（原单 id 删除会漏孤儿向量）
      const ids = (this.db
        .prepare("SELECT id FROM memory_entries WHERE file_path = ?")
        .all(filePath) as any[]).map((r) => Number(r.id));
      this.db
        .prepare("DELETE FROM memory_vec WHERE id IN (SELECT id FROM memory_entries WHERE file_path = ?)")
        .run(filePath);
      this.db
        .prepare("DELETE FROM memory_entries WHERE file_path = ?")
        .run(filePath);
      this.fts.removeIds(ids);
    }
    // 分块
    const chunks = this.chunk(content, 500);
    if (chunks.length === 0) return 0;

    // 批量生成 embedding
    const embeddings = await this.embedding.embedBatch(chunks);
    const now = Date.now();

    // 插入
    const insertEntry = this.db.prepare(
      "INSERT INTO memory_entries (source, file_path, excerpt, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertVec = this.db.prepare(
      "INSERT INTO memory_vec (id, embedding) VALUES (?, ?)",
    );

    const insertAll = this.db.transaction(() => {
      const ftsItems: Array<{ id: number; excerpt: string }> = [];
      for (let i = 0; i < chunks.length; i++) {
        const r = insertEntry.run(source, filePath, chunks[i], hash, now, now);
        const id = Number(r.lastInsertRowid);
        try {
          insertVec.run(id, Buffer.from(embeddings[i].buffer));
        } catch {}
        ftsItems.push({ id, excerpt: chunks[i]! });
      }
      // FTS BM25 通道（与向量同批块）
      this.fts.indexChunks(displayPath ?? filePath, ftsItems);
    });
    insertAll();

    return chunks.length;
  }

  /**
   * 索引目录下所有文件
   */
  async indexDirectory(
    dir: string,
    source: "memory" | "session" | "wiki",
  ): Promise<{ files: number; chunks: number }> {
    let files = 0,
      chunks = 0;
    const entries = await this.walkDir(dir);

    for (const file of entries) {
      const c = await this.indexFile(file, source);
      files++;
      chunks += c;
    }

    return { files, chunks };
  }

  /**
   * 全量重建（删除所有索引，重新构建）
   */
  async rebuildAll(
    dir: string,
    source: "memory" | "session" | "wiki",
  ): Promise<{ files: number; chunks: number }> {
    this.db.prepare("DELETE FROM memory_entries WHERE source = ?").run(source);
    try {
      this.db.prepare("DELETE FROM memory_vec").run();
    } catch {}
    this.fts.clearAll();
    return this.indexDirectory(dir, source);
  }

  private chunk(content: string, maxChars: number): string[] {
    const chunks: string[] = [];
    const paragraphs = content.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
      if (current.length + para.length > maxChars && current) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += "\n\n" + para;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  private async hash(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await Array.fromAsync(
        new Bun.Glob("**/*.md").scan({ cwd: dir, dot: false }),
      );
      for (const rel of entries) results.push(`${dir}/${rel}`);
    } catch {}
    return results;
  }
}
