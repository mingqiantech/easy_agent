import { getDatabase } from "../database.js";
import { now } from "../utils.js";

export interface AuditEntry {
  userId?: string;
  sessionId?: string;
  action: string;
  details?: Record<string, unknown>;
}

/**
 * 审计日志（Week7）
 * 所有用户消息、工具调用、管理操作记录到 audit_logs 表。
 */
export class AuditLogger {
  log(entry: AuditEntry): void {
    getDatabase()
      .prepare(
        `INSERT INTO audit_logs (user_id, session_id, action, details, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        entry.userId ?? null,
        entry.sessionId ?? null,
        entry.action,
        JSON.stringify(entry.details ?? {}),
        now(),
      );
  }

  query(options: {
    userId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  } = {}): any[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.userId) {
      conditions.push("user_id = ?");
      params.push(options.userId);
    }
    if (options.action) {
      conditions.push("action = ?");
      params.push(options.action);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    return getDatabase()
      .prepare(
        `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
  }

  getUserStats(userId: string): {
    totalMessages: number;
    totalToolCalls: number;
    lastActive: number | null;
  } {
    const db = getDatabase();
    const messages = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM audit_logs WHERE user_id = ? AND action = 'message'",
        )
        .get(userId) as any
    )?.c ?? 0;
    const toolCalls = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM audit_logs WHERE user_id = ? AND action = 'tool_call'",
        )
        .get(userId) as any
    )?.c ?? 0;
    const lastActive = (
      db
        .prepare("SELECT MAX(created_at) as t FROM audit_logs WHERE user_id = ?")
        .get(userId) as any
    )?.t ?? null;

    return { totalMessages: messages, totalToolCalls: toolCalls, lastActive };
  }

  /** 清理 90 天前的日志 */
  cleanup(): number {
    const cutoff = now() - 90 * 86400000;
    return getDatabase()
      .prepare("DELETE FROM audit_logs WHERE created_at < ?")
      .run(cutoff).changes;
  }
}
