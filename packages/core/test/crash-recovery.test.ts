import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../src/database.js";
import { SessionManager } from "../src/session.js";
import { now } from "../src/utils.js";

/** 崩溃续跑：active_turns 残留行 → recoverInterruptedTurns 注入续跑队列消息 */
describe("recoverInterruptedTurns（重启续跑被中断任务）", () => {
  let sessions: SessionManager;
  let db: any;

  beforeAll(() => {
    db = getDatabase(":memory:");
    const fakeLlm: any = { generate: async () => ({ content: "ok" }) };
    sessions = new SessionManager(fakeLlm, { defaultModel: "test/model" });
  });

  function seedInterruptedTurn(sessionId: string, resumeCount = 0) {
    db.prepare(
      `INSERT INTO active_turns (session_id, started_at, last_step_at, steps_done, resume_count)
       VALUES (?, ?, ?, 3, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_step_at = excluded.last_step_at, resume_count = excluded.resume_count`,
    ).run(sessionId, now(), now(), resumeCount);
  }

  it("残留台账行 → 入队续跑消息 + 提示消息 + resume_count 递增", () => {
    const s = sessions.create({});
    seedInterruptedTurn(s.id);

    const n = sessions.recoverInterruptedTurns();
    expect(n).toBeGreaterThanOrEqual(1);

    const queued = db
      .prepare(
        "SELECT text FROM pending_queue WHERE session_id = ?",
      )
      .all(s.id) as any[];
    expect(queued.length).toBe(1);
    expect(queued[0].text).toContain("【系统恢复】");

    const msgs = sessions.getMessages(s.id);
    expect(
      msgs.some((m) => m.role === "assistant" && m.content.includes("♻️")),
    ).toBe(true);

    const row = db
      .prepare("SELECT * FROM active_turns WHERE session_id = ?")
      .get(s.id) as any;
    expect(row.resume_count).toBe(1); // 行保留防二次崩溃循环
  });

  it("超过 maxResume → 放弃自动恢复并清理台账", () => {
    const s = sessions.create({});
    seedInterruptedTurn(s.id, 2);

    sessions.recoverInterruptedTurns(2);

    const row = db
      .prepare("SELECT * FROM active_turns WHERE session_id = ?")
      .get(s.id);
    expect(row).toBeFalsy(); // 已清理（bun:sqlite 无行时返回 null）
    const queued = db
      .prepare("SELECT * FROM pending_queue WHERE session_id = ?")
      .all(s.id);
    expect(queued.length).toBe(0); // 不再入队
    const msgs = sessions.getMessages(s.id);
    expect(
      msgs.some((m) => m.content.includes("暂停自动恢复")),
    ).toBe(true);
  });

  it("正常 run() 完成后台账清空（不留残留）", async () => {
    const s = sessions.create({});
    // fakeLlm generate 返回无工具调用 → 单步即完成
    await sessions.run(s.id, "你好");
    const row = db
      .prepare("SELECT * FROM active_turns WHERE session_id = ?")
      .get(s.id);
    expect(row).toBeFalsy();
  });
});
