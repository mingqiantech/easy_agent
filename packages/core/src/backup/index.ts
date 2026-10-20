import fs from "node:fs/promises";
import path from "node:path";
import { getDatabase } from "../database.js";

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  createdAt: number;
}

export interface BackupMemoryFile {
  /** 存档后缀标签，如 MEMORY.default */
  label: string;
  /** 磁盘绝对路径 */
  path: string;
}

/**
 * 数据备份管理器
 * 用 SQLite 的 VACUUM INTO 做一致性快照（WAL 模式下也安全），
 * 同时备份各 agent 工作区的 MEMORY.md/USER.md 等文本记忆（按 label 存档）。
 */
export class BackupManager {
  private memoryFiles: BackupMemoryFile[];

  constructor(
    private backupDir_: string,
    private maxBackups = 10,
    memoryFiles?: BackupMemoryFile[],
  ) {
    this.backupDir = backupDir_;
    this.memoryFiles = memoryFiles ?? [
      { label: "MEMORY.md", path: "MEMORY.md" },
      { label: "USER.md", path: "USER.md" },
    ];
  }

  private backupDir: string;

  get dir(): string {
    return this.backupDir;
  }

  /** 创建备份；opts.keep 可覆盖保留份数（来自设置页热配置） */
  async backup(opts: { keep?: number } = {}): Promise<BackupInfo> {
    await fs.mkdir(this.backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(this.backupDir, `backup-${timestamp}.db`);

    // VACUUM INTO 产生一致性快照，不会锁住主库太久
    const db = getDatabase();
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

    const stat = await fs.stat(backupPath);

    // 同步备份文本记忆（按 label 命名，多工作区不互撞）
    for (const mf of this.memoryFiles) {
      try {
        const content = await fs.readFile(mf.path, "utf-8");
        await fs.writeFile(`${backupPath}.${mf.label}`, content, "utf-8");
      } catch {
        // 文件不存在则跳过
      }
    }

    await this.cleanupOldBackups(opts.keep ?? this.maxBackups);

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
    // 只允许恢复 backupDir 内的文件（防任意路径读取）
    const resolved = path.resolve(backupPath);
    if (!resolved.startsWith(path.resolve(this.backupDir) + path.sep))
      throw new Error(`not a backup file: ${backupPath}`);
    backupPath = resolved;
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
    for (const mf of this.memoryFiles) {
      const memBackup = `${backupPath}.${mf.label}`;
      try {
        const content = await fs.readFile(memBackup, "utf-8");
        await fs.mkdir(path.dirname(mf.path), { recursive: true });
        await fs.writeFile(mf.path, content, "utf-8");
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

  /** 只保留最近 keep 份 */
  private async cleanupOldBackups(keep: number): Promise<void> {
    const backups = await this.list();
    if (backups.length <= keep) return;
    for (const old of backups.slice(keep)) {
      await fs.unlink(old.path).catch(() => {});
      // 清掉附属文本记忆存档（任意 label 后缀）
      try {
        const dir = path.dirname(old.path);
        const base = path.basename(old.path);
        for (const e of await fs.readdir(dir))
          if (e.startsWith(base + "."))
            await fs.unlink(path.join(dir, e)).catch(() => {});
      } catch {}
    }
  }

  private currentDbPath(): string {
    return process.env.EASY_AGENT_DB_PATH ?? path.join(
      process.env.EASY_AGENT_STATE_DIR ?? path.join(process.env.HOME ?? "/tmp", ".easy-agent"),
      "agent.db",
    );
  }
}
