import { getDatabase } from "../database.js";
import { generateId, now } from "../utils.js";

export interface StressOptions {
  /** 并发"用户"数 */
  concurrentUsers?: number;
  /** 每用户操作数 */
  opsPerUser?: number;
}

export interface StressResult {
  totalOps: number;
  successfulOps: number;
  failedOps: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  throughputOpsPerSec: number;
  durationMs: number;
  errors: Array<{ message: string; count: number }>;
}

/**
 * 本地压力测试（Week 12）
 * 纯数据库层并发写读（不涉及 LLM 调用，零成本可重复）。
 * 每个"用户"创建会话 + 批量写消息 + 读回。
 */
export async function localStressTest(options: StressOptions = {}): Promise<StressResult> {
  const concurrentUsers = options.concurrentUsers ?? 20;
  const opsPerUser = options.opsPerUser ?? 50;
  const totalOps = concurrentUsers * opsPerUser;

  const latencies: number[] = [];
  const errors = new Map<string, number>();
  let failed = 0;

  const db = getDatabase();
  const startTime = now();

  const worker = async () => {
    const sid = generateId();
    const ts = now();
    try {
      db.prepare(
        `INSERT INTO sessions (id, title, agent_id, model, status, created_at, updated_at)
         VALUES (?, NULL, 'stress', 'test-model', 'active', ?, ?)`,
      ).run(sid, ts, ts);
    } catch (e: any) {
      errors.set(e.message, (errors.get(e.message) ?? 0) + 1);
      failed++;
      return;
    }

    for (let i = 0; i < opsPerUser; i++) {
      const t0 = performance.now();
      try {
        db.prepare(
          `INSERT INTO messages (id, session_id, role, content, created_at)
           VALUES (?, ?, 'user', ?, ?)`,
        ).run(generateId(), sid, `stress message ${i}`, now());

        // 混合读操作
        if (i % 5 === 0) {
          db.prepare(
            "SELECT content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
          ).get(sid);
        }
        latencies.push(performance.now() - t0);
      } catch (e: any) {
        errors.set(e.message, (errors.get(e.message) ?? 0) + 1);
        failed++;
      }
    }

    // 清理
    try {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    } catch {
      // 级联已删除消息
    }
  };

  await Promise.all(Array.from({ length: concurrentUsers }, () => worker()));

  const durationMs = now() - startTime;
  const successful = latencies.length;

  return {
    totalOps,
    successfulOps: successful,
    failedOps: failed,
    avgLatencyMs:
      successful > 0 ? latencies.reduce((a, b) => a + b, 0) / successful : 0,
    maxLatencyMs: successful > 0 ? Math.max(...latencies) : 0,
    throughputOpsPerSec: durationMs > 0 ? (totalOps / durationMs) * 1000 : 0,
    durationMs,
    errors: Array.from(errors.entries()).map(([message, count]) => ({ message, count })),
  };
}
