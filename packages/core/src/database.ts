import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
let _db: Database | null = null;
export function getDatabase(dbPath?: string): Database {
  if (_db) return _db;
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });
  _db = new Database(resolvedPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA busy_timeout = 5000");
  initializeSchema(_db);
  return _db;
}
function getDefaultDbPath(): string {
  const stateDir =
    process.env.EASY_AGENT_STATE_DIR ??
    path.join(require("node:os").homedir(), ".local", "share", "easy-agent");
  return path.join(stateDir, "agent.db");
}
function initializeSchema(db: Database): void {
  db.exec(`
    --会话表
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      agent_id TEXT NOT NULL DEFAULT 'default',
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON sessions(updated_at DESC);

    -- 消息表
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at ASC);

    -- 短期记忆表（Dreaming 晋升来源）
    CREATE TABLE IF NOT EXISTS short_term_memory (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      origin TEXT,
      recall_count INTEGER NOT NULL DEFAULT 0,
      unique_queries INTEGER NOT NULL DEFAULT 0,
      recall_days TEXT DEFAULT '[]',
      last_recalled_at INTEGER,
      created_at INTEGER NOT NULL,
      promoted_at INTEGER,
      forgotten_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_stm_active
      ON short_term_memory(created_at)
      WHERE promoted_at IS NULL AND forgotten_at IS NULL;

    -- Dreaming 状态表
    CREATE TABLE IF NOT EXISTS dreaming_state (
      phase TEXT PRIMARY KEY,
      last_run_at INTEGER NOT NULL,
      state TEXT DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    -- 会话摄入状态表
    CREATE TABLE IF NOT EXISTS session_ingestion (
      session_id TEXT PRIMARY KEY,
      snippet_count INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL
    );
    -- Cron 定时任务表
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      schedule_kind TEXT NOT NULL,
      schedule_config TEXT NOT NULL,
      payload_kind TEXT NOT NULL,
      payload_config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cron_due
      ON cron_jobs(enabled, next_run_at);

    -- Cron 运行记录表
    CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    -- 工具调用记录表（可观测性统计）
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    -- 记忆条目表（向量搜索 join 用）
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      file_path TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
