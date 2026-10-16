import { getDatabase } from "../database.js";
import { generateId, now } from "../utils.js";

export interface User {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user" | "guest";
  status: "active" | "suspended" | "deleted";
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number | null;
}

export interface UserQuota {
  dailyTokenLimit: number;
  dailyTokensUsed: number;
  dailyRequestLimit: number;
  dailyRequestsUsed: number;
  quotaResetAt: number;
}

const DAY_MS = 86400000;

function rowToUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

/**
 * 用户管理器（Week7 多用户）
 * 渠道身份自动映射为内部用户，带角色、状态、每日配额。
 */
export class UserManager {
  create(input: {
    username: string;
    displayName?: string;
    role?: "admin" | "user" | "guest";
  }): User {
    const db = getDatabase();
    const id = generateId();
    const ts = now();

    db.prepare(
      `INSERT INTO users (id, username, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, input.username, input.displayName ?? null, input.role ?? "user", ts, ts);

    db.prepare(
      `INSERT INTO user_quotas (user_id, quota_reset_at, updated_at)
       VALUES (?, ?, ?)`,
    ).run(id, ts + DAY_MS, ts);

    return this.get(id)!;
  }

  get(id: string): User | null {
    const row = getDatabase()
      .prepare("SELECT * FROM users WHERE id = ? AND status != 'deleted'")
      .get(id) as any;
    return row ? rowToUser(row) : null;
  }

  getByUsername(username: string): User | null {
    const row = getDatabase()
      .prepare("SELECT * FROM users WHERE username = ? AND status != 'deleted'")
      .get(username) as any;
    return row ? rowToUser(row) : null;
  }

  /** 渠道身份 → 内部用户（首次自动注册） */
  getOrCreateByChannel(
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): User {
    const db = getDatabase();
    const link = db
      .prepare(
        "SELECT user_id FROM user_channels WHERE channel = ? AND channel_user_id = ?",
      )
      .get(channel, channelUserId) as any;

    if (link) {
      const user = this.get(link.user_id);
      if (user) {
        db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now(), user.id);
        return user;
      }
    }

    const username = `${channel}_${channelUserId}`.slice(0, 30);
    let user = this.getByUsername(username);
    if (!user) {
      user = this.create({ username, displayName, role: "user" });
    }

    db.prepare(
      `INSERT OR IGNORE INTO user_channels (id, user_id, channel, channel_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(generateId(), user.id, channel, channelUserId, now());

    return user;
  }

  list(limit = 50): User[] {
    return getDatabase()
      .prepare(
        "SELECT * FROM users WHERE status != 'deleted' ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
      .map((r: any) => rowToUser(r));
  }

  setRole(userId: string, role: "admin" | "user" | "guest"): void {
    getDatabase()
      .prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
      .run(role, now(), userId);
  }

  suspend(userId: string): void {
    getDatabase()
      .prepare("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?")
      .run(now(), userId);
  }

  unsuspend(userId: string): void {
    getDatabase()
      .prepare("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?")
      .run(now(), userId);
  }

  /** 获取配额（跨过重置时间自动归零） */
  getQuota(userId: string): UserQuota | null {
    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM user_quotas WHERE user_id = ?")
      .get(userId) as any;
    if (!row) return null;

    if (now() > row.quota_reset_at) {
      db.prepare(
        `UPDATE user_quotas
         SET daily_tokens_used = 0, daily_requests_used = 0, quota_reset_at = ?, updated_at = ?
         WHERE user_id = ?`,
      ).run(now() + DAY_MS, now(), userId);
      row.daily_tokens_used = 0;
      row.daily_requests_used = 0;
      row.quota_reset_at = now() + DAY_MS;
    }

    return {
      dailyTokenLimit: row.daily_token_limit,
      dailyTokensUsed: row.daily_tokens_used,
      dailyRequestLimit: row.daily_request_limit,
      dailyRequestsUsed: row.daily_requests_used,
      quotaResetAt: row.quota_reset_at,
    };
  }

  /** 请求前配额检查 */
  checkQuota(userId: string, tokensNeeded: number): { allowed: boolean; reason?: string } {
    const quota = this.getQuota(userId);
    if (!quota) return { allowed: true };
    if (quota.dailyRequestsUsed >= quota.dailyRequestLimit) {
      return { allowed: false, reason: `日请求上限 ${quota.dailyRequestLimit} 已用尽` };
    }
    if (quota.dailyTokensUsed + tokensNeeded > quota.dailyTokenLimit) {
      return {
        allowed: false,
        reason: `日 token 上限 ${quota.dailyTokenLimit} 不足（已用 ${quota.dailyTokensUsed}）`,
      };
    }
    return { allowed: true };
  }

  /** 请求后记账 */
  recordUsage(userId: string, tokensUsed: number): void {
    const db = getDatabase();
    db.prepare(
      `UPDATE user_quotas
       SET daily_tokens_used = daily_tokens_used + ?,
           daily_requests_used = daily_requests_used + 1,
           updated_at = ?
       WHERE user_id = ?`,
    ).run(tokensUsed, now(), userId);
    db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now(), userId);
  }

  /** 会话归属 */
  associateSession(sessionId: string, userId: string): void {
    getDatabase()
      .prepare("UPDATE sessions SET user_id = ? WHERE id = ?")
      .run(userId, sessionId);
  }

  verifySessionOwnership(sessionId: string, userId: string): boolean {
    const row = getDatabase()
      .prepare("SELECT user_id FROM sessions WHERE id = ?")
      .get(sessionId) as any;
    return row?.user_id == null || row.user_id === userId;
  }
}
