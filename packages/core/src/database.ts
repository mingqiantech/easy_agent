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
  `);
}
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
