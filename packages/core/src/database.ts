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
    path.join(require("node:os").homedir(), ".easy-agent");
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

    -- token 用量记录表（每步 LLM 调用）
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at);

    -- 记忆条目表（向量搜索 join 用）
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      file_path TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Week7: 用户表
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user', 'guest')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_active_at INTEGER
    );

    -- 渠道身份关联表
    CREATE TABLE IF NOT EXISTS user_channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(channel, channel_user_id)
    );

    -- 用户配额表
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      daily_token_limit INTEGER NOT NULL DEFAULT 100000,
      daily_tokens_used INTEGER NOT NULL DEFAULT 0,
      daily_request_limit INTEGER NOT NULL DEFAULT 100,
      daily_requests_used INTEGER NOT NULL DEFAULT 0,
      quota_reset_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 审计日志表
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      session_id TEXT,
      action TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_user
      ON audit_logs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_action
      ON audit_logs(action, created_at DESC);

    -- Week9: 团队表
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      description TEXT,
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 团队成员
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member', 'viewer')),
      joined_at INTEGER NOT NULL,
      UNIQUE(team_id, user_id)
    );

    -- 团队工作区
    CREATE TABLE IF NOT EXISTS team_workspaces (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      work_dir TEXT NOT NULL,
      shared_memory TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(team_id, name)
    );

    -- 通知表
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('info', 'warning', 'error')),
      channel TEXT NOT NULL DEFAULT 'in_app',
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user
      ON notifications(user_id, read, created_at DESC);
  `);

  // Week7: 给 sessions 加 user_id 列（存在则跳过）
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "user_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT");
  }
  // 首页会话：每个 agent 置顶且不可删除的会话
  if (!cols.some((c) => c.name === "pinned")) {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  }
}
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
