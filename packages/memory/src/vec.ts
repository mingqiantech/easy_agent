import type { Database } from "bun:sqlite";

/**
 * sqlite-vec 加速向量索引（可选依赖，加载失败自动退回 memory_vec 暴力扫）。
 * - 表 vec0 维度在首批 embedding 后惰性建立（一个 fingerprint 生命周期内维度恒定）
 * - rowid 与 memory_entries.id 对齐；source 过滤靠 join
 * - 注意：bun 编译单文件下 .so 无法从虚拟 fs dlopen → 自动退回，源码/服务运行享加速
 */
export class VecIndex {
  private tried = false;
  private loaded = false;
  private tableDims = 0;
  readonly table = "memory_vec_v";

  constructor(private _db: Database) {}

  /** 绑定的数据库（避免调用方误用 getDatabase 单例跨库读写） */
  get db(): Database {
    return this._db;
  }

  /** 当前 vec0 表维度（0=未建）；检索拓扑展示用 */
  get dims(): number {
    return this.tableDims;
  }

  /** 扩展是否可用（不含表是否已建） */
  get available(): boolean {
    if (!this.tried) this.tryLoad();
    return this.loaded;
  }

  get ready(): boolean {
    if (!this.available) return false;
    if (this.tableDims > 0) return true;
    // 重启后既有 vec0 表：从 schema 懒探测维度
    try {
      const row = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(this.table) as any;
      const m = /float\[(\d+)\]/.exec(String(row?.sql ?? ""));
      if (m) this.tableDims = Number(m[1]);
    } catch {}
    return this.tableDims > 0;
  }

  private tryLoad(): void {
    this.tried = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(this.db);
      this.loaded = true;
    } catch (e: any) {
      console.warn(
        "🧠 sqlite-vec 扩展不可用，向量检索退回暴力扫描:",
        String(e?.message).slice(0, 100),
      );
      this.loaded = false;
    }
  }

  /** 按首批向量维度建表（幂等；已存在但维度不符会重建——配合指纹重置使用） */
  ensureTable(dim: number): boolean {
    if (!this.available) return false;
    if (this.tableDims === dim) return true;
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${this.table}`);
      this.db.exec(
        `CREATE VIRTUAL TABLE ${this.table} USING vec0(embedding float[${dim}] distance_metric=cosine)`,
      );
      this.tableDims = dim;
      return true;
    } catch (e: any) {
      console.warn("🧠 vec0 建表失败:", String(e?.message).slice(0, 100));
      this.loaded = false;
      return false;
    }
  }

  insert(id: number, vec: Float32Array): void {
    if (!this.ready) return;
    try {
      this.db
        .prepare(`INSERT OR REPLACE INTO ${this.table}(rowid, embedding) VALUES (?, ?)`)
        .run(id, Buffer.from(vec.buffer));
    } catch {}
  }

  removeIds(ids: number[]): void {
    if (!this.ready || !ids.length) return;
    const del = this.db.prepare(`DELETE FROM ${this.table} WHERE rowid = ?`);
    for (const id of ids) {
      try {
        del.run(id);
      } catch {}
    }
  }

  dropAll(): void {
    try {
      this.db.exec(`DELETE FROM ${this.table}`);
    } catch {}
  }

  /**
   * KNN 检索（cosine distance → score = 1 - distance）。
   * 带 source 过滤时按 4x 超采样再筛（vec0 的 k 不做 join 后截断）。
   */
  search(
    query: Float32Array,
    k: number,
    source?: string,
  ): Array<{ id: number; score: number }> | null {
    if (!this.ready) return null;
    const q = Buffer.from(query.buffer);
    try {
      const rows = source
        ? (this.db
            .prepare(
              `SELECT v.rowid AS id, v.distance AS dist
               FROM ${this.table} v JOIN memory_entries e ON e.id = v.rowid
               WHERE v.embedding MATCH ? AND k = ? AND e.source = ?
               ORDER BY v.distance`,
            )
            .all(q, k * 4, source) as any[])
        : (this.db
            .prepare(
              `SELECT rowid AS id, distance AS dist FROM ${this.table}
               WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
            )
            .all(q, k) as any[]);
      return rows
        .slice(0, k)
        .map((r) => ({ id: Number(r.id), score: Math.max(0, 1 - Number(r.dist)) }));
    } catch {
      return null;
    }
  }
}
