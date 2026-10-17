import fs from "node:fs/promises";
import path from "node:path";
import { getDatabase } from "../database.js";

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  createdAt: number;
}

/**
 * 数据备份管理器
 * 用 SQLite 的 VACUUM INTO 做一致性快照（WAL 模式下也安全），
 * 同时备份 MEMORY.md 等文本记忆。
 */
export class BackupManager {
  private backupDir: string;
  private maxBackups: number;

  constructor(backupDir: string, maxBackups = 10) {
    this.backupDir = backupDir;
    this.maxBackups = maxBackups;
  }

  /** 创建备份 */
  async backup(): Promise<BackupInfo> {
    await fs.mkdir(this.backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.backupDir, `backup-${timestamp}.db`);

    // VACUUM INTO 产生一致性快照，不会锁住主库太久
    const db = getDatabase();
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    const stat = await fs.stat(backupPath);

    // 同步备份文本记忆
    for (const file of ["MEMORY.md", "USER.md"]) {
      try {
        const content = await fs.readFile(file, "utf-8");
        await fs.writeFile(`${backupPath}.${file}`, content, "utf-8");
      } catch {
        // 文件不存在则跳过
      }
    }

    await this.cleanupOldBackups();

    return { name: path.basename(backupPath), path: backupPath, size: stat.size, createdAt: stat.mtimeMs };
  }

  /** 列出所有备份（新→旧） */
  async list(): Promise<BackupInfo[]> {
    try {
      const entries = await fs.readdir(this.backupDir, { withFileTypes: true });
      const backups: BackupInfo[] = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".db")) continue;
        const fullPath = path.join(this.backupDir, e.name);
        const stat = await fs.stat(fullPath);
        backups.push({ name: e.name, path: fullPath, size: stat.size, createdAt: stat.mtimeMs });
      }
      return backups.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  /**
   * 恢复备份
   * 注意：恢复后进程持有的旧 db 连接失效，调用方应重启服务。
   */
  async restore(backupPath: string): Promise<void> {
    try {
      await fs.access(backupPath);
    } catch {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    // 恢复前先备份当前数据（安全网）
    try {
      await this.backup();
    } catch {
      // 当前库可能已损坏，忽略
    }

    const dbPath = this.currentDbPath();
    await fs.copyFile(backupPath, dbPath);

    // 恢复文本记忆
    for (const file of ["MEMORY.md", "USER.md"]) {
      const memBackup = `${backupPath}.${file}`;
      try {
        const content = await fs.readFile(memBackup, "utf-8");
        await fs.writeFile(file, content, "utf-8");
      } catch {
        // 该备份没有此文件
      }
    }

    // WAL 附属文件删除，避免脏读
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await fs.unlink(dbPath + suffix);
      } catch {
        // 不存在
      }
    }
  }

  /** 只保留最近 maxBackups 份 */
  private async cleanupOldBackups(): Promise<void> {
    const backups = await this.list();
    if (backups.length <= this.maxBackups) return;
    for (const old of backups.slice(this.maxBackups)) {
      await fs.unlink(old.path).catch(() => {});
      for (const suffix of [".MEMORY.md", ".USER.md"]) {
        await fs.unlink(old.path + suffix).catch(() => {});
      }
    }
  }

  private currentDbPath(): string {
    return process.env.EASY_AGENT_DB_PATH ?? path.join(
      process.env.EASY_AGENT_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".easy-agent"),
      "agent.db",
    );
  }
}
