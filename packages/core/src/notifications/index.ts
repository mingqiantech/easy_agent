import { getDatabase } from "../database.js";
import { generateId, now } from "../utils.js";

export type NotificationLevel = "info" | "warning" | "error";

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  level: NotificationLevel;
  channel: string;
  read: boolean;
  createdAt: number;
}

/**
 * 通知管理器（Week 9）
 * 站内通知落库；外部渠道（webhook 等）通过注册 channel 发送。
 */
export class NotificationManager {
  async notify(
    userId: string,
    title: string,
    body: string,
    options: { level?: NotificationLevel; channel?: string } = {},
  ): Promise<Notification> {
    const notification: Notification = {
      id: generateId(),
      userId,
      title,
      body,
      level: options.level ?? "info",
      channel: options.channel ?? "in_app",
      read: false,
      createdAt: now(),
    };

    getDatabase()
      .prepare(
        `INSERT INTO notifications (id, user_id, title, body, level, channel, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        notification.id,
        notification.userId,
        notification.title,
        notification.body,
        notification.level,
        notification.channel,
        notification.createdAt,
      );

    return notification;
  }

  list(userId: string, unreadOnly = false, limit = 50): Notification[] {
    const sql = unreadOnly
      ? `SELECT * FROM notifications WHERE user_id = ? AND read = 0
         ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM notifications WHERE user_id = ?
         ORDER BY created_at DESC LIMIT ?`;

    return (getDatabase().prepare(sql).all(userId, limit) as any[]).map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      title: r.title,
      body: r.body,
      level: r.level,
      channel: r.channel,
      read: !!r.read,
      createdAt: r.created_at,
    }));
  }

  unreadCount(userId: string): number {
    const row = getDatabase()
      .prepare("SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0")
      .get(userId) as any;
    return row?.c ?? 0;
  }

  markRead(notificationId: string): void {
    getDatabase().prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(notificationId);
  }

  markAllRead(userId: string): number {
    return getDatabase()
      .prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0")
      .run(userId).changes;
  }

  /** 清理 N 天前的已读通知 */
  cleanup(olderThanDays = 30): number {
    const cutoff = now() - olderThanDays * 86400000;
    return getDatabase()
      .prepare("DELETE FROM notifications WHERE read = 1 AND created_at < ?")
      .run(cutoff).changes;
  }
}

/** Webhook 外发通知（如接监控告警） */
export async function sendWebhookNotification(
  url: string,
  payload: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
