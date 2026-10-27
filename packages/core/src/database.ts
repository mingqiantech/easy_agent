import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { estimateCostUsd } from "@easy-agent/llm/pricing";
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
  // 环境变量优先（与 BackupManager.currentDbPath 一致）；以前只认 STATE_DIR，
  // 导致测试里只设 DB_PATH 时 getDatabase() 落到生产库造成互刷污染
  if (process.env.EASY_AGENT_DB_PATH) return process.env.EASY_AGENT_DB_PATH;
  const stateDir =
    process.env.EASY_AGENT_STATE_DIR ??
    path.join(require("node:os").homedir(), ".easy-agent");
  return path.join(stateDir, "agent.db");
}

/**
 * 独立数据库实例（不走单例）：供测试/多库场景使用。
 * bun test 文件并发共享 getDatabase 单例，全局 DELETE 会互刷数据——用这个隔离。
 */
export function freshDatabase(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  initializeSchema(db);
  return db;
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

    -- 消息归档表（上下文压缩时旧消息移入这里，LLM 上下文不含，UI 全量展示）
    CREATE TABLE IF NOT EXISTS messages_archive (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_archive_session
      ON messages_archive(session_id, created_at ASC);

    -- 运行中轮次台账：轮开始写入、每步 checkpoint、正常结束删除；
    -- 进程崩溃/重启时 finally 不执行 → 残留行即“被中断任务”，启动时扫描续跑
    CREATE TABLE IF NOT EXISTS active_turns (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      last_step_at INTEGER NOT NULL,
      steps_done INTEGER NOT NULL DEFAULT 0,
      resume_count INTEGER NOT NULL DEFAULT 0
    );

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
      forgotten_at INTEGER,
      dormant_at INTEGER
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
      cached_read_tokens INTEGER NOT NULL DEFAULT 0,
      cached_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage (created_at);

    -- 排队消息持久化：转向/队列消息落库，网关重启后自动恢复续跑
    CREATE TABLE IF NOT EXISTS pending_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_queue_session
      ON pending_queue (session_id, created_at);

    -- 子 Agent 运行记录（父子关系 + 可观测）
    CREATE TABLE IF NOT EXISTS sub_agent_runs (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      parent_agent TEXT,
      child_session_id TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      steps INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_started
      ON sub_agent_runs (started_at DESC);

    -- 记忆条目表（向量搜索 join 用）
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      file_path TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content_hash TEXT,
      created_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    -- 向量存储（embedding BLOB，dim 由长度决定）
    CREATE TABLE IF NOT EXISTS memory_vec (
      id INTEGER PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    -- 通用元数据（如 embedding 指纹，用于 provider/模型变更检测）
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
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

  // 2026-10-27 Dreaming 分层改造：软休眠列（行永不删，被召回可复活）
  const stmCols = db.prepare("PRAGMA table_info(short_term_memory)").all() as Array<{ name: string }>;
  if (!stmCols.some((c) => c.name === "dormant_at")) {
    db.exec("ALTER TABLE short_term_memory ADD COLUMN dormant_at INTEGER");
  }

  // 旧库的 memory_entries 缺 content_hash/created_at 两列（IncrementalIndex 依赖）→ 补齐
  const meCols = db.prepare("PRAGMA table_info(memory_entries)").all() as Array<{ name: string }>;
  if (!meCols.some((c) => c.name === "content_hash")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN content_hash TEXT");
  }
  if (!meCols.some((c) => c.name === "created_at")) {
    db.exec("ALTER TABLE memory_entries ADD COLUMN created_at INTEGER");
  }

  // token_usage 缓存列（厂商计费口径：prompt_tokens 含缓存；此两列拆分量）
  const tuCols = db.prepare("PRAGMA table_info(token_usage)").all() as Array<{ name: string }>;
  if (!tuCols.some((c) => c.name === "cached_read_tokens")) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cached_read_tokens INTEGER NOT NULL DEFAULT 0");
  }
  if (!tuCols.some((c) => c.name === "cached_write_tokens")) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cached_write_tokens INTEGER NOT NULL DEFAULT 0");
  }
  // 行级计费成本（USD；定价缺失 NULL，不冒充 0）
  if (!tuCols.some((c) => c.name === "cost_usd")) {
    db.exec("ALTER TABLE token_usage ADD COLUMN cost_usd REAL");
  }
  // 存量行补算成本（一次性：只碰 cost_usd IS NULL 的行）
  const unpriced = db
    .prepare(
      `SELECT id, model, prompt_tokens, completion_tokens, cached_read_tokens, cached_write_tokens
       FROM token_usage WHERE cost_usd IS NULL`,
    )
    .all() as Array<{
      id: number; model: string; prompt_tokens: number;
      completion_tokens: number; cached_read_tokens: number; cached_write_tokens: number;
    }>;
  if (unpriced.length > 0) {
    const upd = db.prepare("UPDATE token_usage SET cost_usd = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const r of unpriced) {
        const cost = estimateCostUsd(r.model, {
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          cacheReadTokens: r.cached_read_tokens,
          cacheWriteTokens: r.cached_write_tokens,
        });
        upd.run(cost ?? null, r.id);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
