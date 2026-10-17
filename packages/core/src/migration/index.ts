import fs from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { getDatabase } from "../database.js";

export interface Migration {
  version: number;
  name: string;
  /** 正向 SQL 语句列表 */
  up: string[];
  /** 回滚 SQL（可选） */
  down?: string[];
}

export interface MigrationReport {
  applied: number;
  from: number;
  to: number;
  names: string[];
}

/**
 * 数据迁移管理器（Week 12）
 * 版本递增执行 + 数据导出/导入（JSON），用于跨实例搬迁与灾备演练。
 */
export class MigrationManager {
  private migrations: Migration[] = [];
  private db: Database;

  constructor(db: Database = getDatabase()) {
    this.db = db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migration_versions (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)",
    );
  }

  register(migration: Migration): void {
    if (this.migrations.some((m) => m.version === migration.version)) {
      throw new Error(`Duplicate migration version: ${migration.version}`);
    }
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  currentVersion(): number {
    const row = this.db
      .prepare("SELECT MAX(version) as v FROM migration_versions")
      .get() as any;
    return row?.v ?? 0;
  }

  pending(): Migration[] {
    const cur = this.currentVersion();
    return this.migrations.filter((m) => m.version > cur);
  }

  migrate(): MigrationReport {
    const from = this.currentVersion();
    const todo = this.pending();
    const names: string[] = [];

    for (const m of todo) {
      const tx = this.db.transaction(() => {
        for (const sql of m.up) this.db.exec(sql);
        this.db
          .prepare(
            "INSERT INTO migration_versions (version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(m.version, m.name, Date.now());
      });
      tx();
      names.push(`${m.version}:${m.name}`);
    }

    return { applied: todo.length, from, to: this.currentVersion(), names };
  }

  /** 全库导出为 JSON（不含迁移版本表，导入后另行恢复） */
  async exportJson(outputPath: string): Promise<{ tables: number; rows: number }> {
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'migration_versions'",
      )
      .all() as Array<{ name: string }>;

    const data: Record<string, unknown[]> = {};
    let totalRows = 0;
    for (const t of tables) {
      const rows = this.db.prepare(`SELECT * FROM "${t.name}"`).all() as unknown[];
      data[t.name] = rows;
      totalRows += rows.length;
    }

    const payload = {
      exportedAt: Date.now(),
      schemaVersion: this.currentVersion(),
      data,
    };
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), "utf-8");
    return { tables: tables.length, rows: totalRows };
  }

  /**
   * 从 JSON 导入（按表 INSERT OR REPLACE）。
   * 只覆盖文件中出现的表，不清空其他数据。
   */
  async importJson(inputPath: string): Promise<{ tables: number; rows: number }> {
    const content = await fs.readFile(inputPath, "utf-8");
    const payload = JSON.parse(content) as {
      schemaVersion?: number;
      data: Record<string, Array<Record<string, unknown>>>;
    };

    let tables = 0;
    let rows = 0;

    for (const [tableName, tableRows] of Object.entries(payload.data ?? {})) {
      if (!Array.isArray(tableRows) || tableRows.length === 0) continue;

      const exists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tableName);
      if (!exists) continue; // 目标库没有该表则跳过

      const columns = Object.keys(tableRows[0]);
      const placeholders = columns.map(() => "?").join(", ");
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      );

      const tx = this.db.transaction(() => {
        for (const row of tableRows) {
          stmt.run(...columns.map((c) => row[c] as never));
          rows++;
        }
      });
      tx();
      tables++;
    }

    // 恢复 schema 版本（取较高者）
    if (payload.schemaVersion) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO migration_versions (version, name, applied_at) VALUES (?, 'imported', ?)",
        )
        .run(payload.schemaVersion, Date.now());
    }

    return { tables, rows };
  }
}
