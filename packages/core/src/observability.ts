import { getDatabase } from "./database.js";

export interface AgentStats {
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  tokenUsage: { prompt: number; completion: number; total: number };
  avgResponseTimeMs: number;
  sessionsByModel: Record<string, number>;
}

export class Observability {
  private startTime = Date.now();
  private responseTimes: number[] = [];

  recordResponseTime(ms: number): void {
    this.responseTimes.push(ms);
    if (this.responseTimes.length > 1000) this.responseTimes.shift();
  }

  getStats(): AgentStats {
    const db = getDatabase();
    const sessionCount =
      (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any)?.c ?? 0;
    const msgCount =
      (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any)?.c ?? 0;

    const modelStats: Record<string, number> = {};
    const sessions = db.prepare("SELECT model FROM sessions").all() as any[];

    for (const s of sessions)
      modelStats[s.model] = (modelStats[s.model] ?? 0) + 1;

    return {
      totalSessions: sessionCount,
      totalMessages: msgCount,
      totalToolCalls:
        (db.prepare("SELECT COUNT(*) as c FROM tool_calls").get() as any)?.c ??
        0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      avgResponseTimeMs:
        this.responseTimes.length > 0
          ? Math.round(
              this.responseTimes.reduce((a, b) => a + b, 0) /
                this.responseTimes.length,
            )
          : 0,
      sessionsByModel: modelStats,
    };
  }

  getHealthCheck(): Record<string, unknown> {
    return {
      status: "ok",
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      stats: this.getStats(),
      version: "0.4.0",
    };
  }
}
