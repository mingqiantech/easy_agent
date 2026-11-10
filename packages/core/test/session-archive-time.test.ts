import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../src/database.js";
import { SessionManager } from "../src/session.js";

/** 时间归档测试（2026-11-02 elf 拍板：单会话滚动，归档阈值 60 天）：
 * 超期非 system 消息移入 messages_archive（UI 全量可见、LLM 上下文变轻）；
 * 超期非置顶会话整场 status='archived'（列表隐藏）。 */
const DAY = 86400000;

function makeSessions(): SessionManager {
  const fakeLlm: any = { generate: async () => ({ content: "摘要" }) };
  return new SessionManager(fakeLlm, { defaultModel: "test/model" });
}

/** 把某会话最早的 n 条非 system 消息时间拨回 daysAgo 天 */
function backdate(sessionId: string, n: number, daysAgo = 61): number {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id FROM messages WHERE session_id = ? AND role != 'system'
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(sessionId, n) as any[];
  const t = Date.now() - daysAgo * DAY;
  for (const r of rows) db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(t, r.id);
  return rows.length;
}

describe("archiveOlderThan（时间归档）", () => {
  let sessions: SessionManager;
  beforeAll(() => {
    getDatabase(":memory:");
    sessions = makeSessions();
  });

  it("超 60 天的旧消息进 messages_archive；system 不动；全量历史仍可见", () => {
    const s = sessions.create({ systemPrompt: "你是测试助手" });
    for (let i = 0; i < 30; i++) {
      sessions.addMessage(s.id, { role: i % 2 ? "assistant" : "user", content: `老消息 ${i} ${"y".repeat(80)}` });
    }
    expect(backdate(s.id, 12)).toBe(12);

    const r = sessions.archiveOlderThan(60, 10);
    expect(r.archivedMessages).toBe(12);

    // LLM 上下文：30 - 12 + system = 19 条，且无超期消息
    const active = sessions.getMessages(s.id);
    expect(active.length).toBe(19);
    expect(active.filter((m: any) => m.createdAt < Date.now() - 60 * DAY && m.role !== "system").length).toBe(0);
    expect(active.some((m) => m.role === "system")).toBe(true); // 工作区头部保留

    // UI 全量：活跃 + 归档 = 31，归档段带 archived 标记且按原时间可排序
    const full = sessions.getFullMessages(s.id);
    expect(full.length).toBe(31);
    const archived = full.filter((m: any) => m.archived);
    expect(archived.length).toBe(12);
    expect(archived[0].content).toContain("老消息 0");
  });

  it("最近 keepRecent 条即使超期也无条件保留（防掏空）", () => {
    const s = sessions.create({ systemPrompt: "你是测试助手" });
    for (let i = 0; i < 8; i++) {
      sessions.addMessage(s.id, { role: i % 2 ? "assistant" : "user", content: `短会话 ${i}` });
    }
    backdate(s.id, 8); // 全部 61 天前
    const r = sessions.archiveOlderThan(60, 10);
    expect(r.archivedMessages).toBe(0);
    expect(sessions.getMessages(s.id).length).toBe(9);
  });

  it("归档幂等：第二次跑不重复搬、不报错", () => {
    const before = getDatabase()
      .prepare("SELECT COUNT(*) c FROM messages_archive")
      .get() as any;
    const r = sessions.archiveOlderThan(60, 10);
    expect(r.archivedMessages).toBe(0);
    const after = getDatabase().prepare("SELECT COUNT(*) c FROM messages_archive").get() as any;
    expect(after.c).toBe(before.c);
  });

  it("超期未更新的非置顶会话整场 archived 并从列表隐藏；pinned 永不归档", () => {
    const db = getDatabase();
    const s1 = sessions.create({ agentId: "tester" }); // 非置顶
    const s2 = sessions.create({ agentId: "tester", pinned: true, systemPrompt: "首页" });
    const old = Date.now() - 61 * DAY;
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id IN (?, ?)").run(old, s1.id, s2.id);

    const r = sessions.archiveOlderThan(60, 10);
    expect(r.archivedSessions).toBeGreaterThanOrEqual(1);
    expect(sessions.list(100, "tester").map((x) => x.id)).not.toContain(s1.id);
    expect(sessions.list(100, "tester").map((x) => x.id)).toContain(s2.id);
    // 数据没删，只是隐藏
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(s1.id) as any).status).toBe("archived");
  });
});

describe("hasPinned / findByTitle 不受 list 截断窗口影响（2026-11-06 重复首页 bug 回归）", () => {
  it("会话数超 list(50) 时 pinned 仍判存在；cron 标题复用仍命中", () => {
    const s = makeSessions();
    const home = s.create({ agentId: "crowded", pinned: true, systemPrompt: "首页", title: "首页" });
    for (let i = 0; i < 60; i++) {
      const x = s.create({ agentId: "crowded", title: `[cron] t${i}` });
      s.addMessage(x.id, { role: "user", content: String(i) }); // 推 updated_at，把首页顶出任何 50 窗口
    }
    expect(s.hasPinned("crowded")).toBe(true);
    expect(s.findByTitle("首页", "crowded")?.id).toBe(home.id);
    expect(s.findByTitle("[cron] t59", "crowded")?.title).toBe("[cron] t59");
    expect(s.findByTitle("[cron] 不存在", "crowded")).toBeNull();
    expect(s.hasPinned("nobody")).toBe(false);
  });
});

describe("delete 连带清无-FK 关联表（2026-11-10 孤儿 token_usage 修复回归）", () => {
  it("删会话后 token_usage/session_ingestion/tool_calls/audit_logs 无孤儿", () => {
    const s = makeSessions();
    const x = s.create({ agentId: "gc" });
    const db = getDatabase();
    db.prepare("INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?,?,?,?,?,?)").run(x.id, "m", 1, 2, 3, Date.now());
    db.prepare("INSERT INTO session_ingestion (session_id, snippet_count, ingested_at) VALUES (?,?,?)").run(x.id, 1, Date.now());
    db.prepare("INSERT INTO tool_calls (session_id, tool_name, created_at) VALUES (?,?,?)").run(x.id, "t", Date.now());
    db.prepare("INSERT INTO audit_logs (session_id, action, created_at) VALUES (?,?,?)").run(x.id, "del", Date.now());
    expect(s.delete(x.id)).toBe(true);
    const q = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE session_id = ?`).get(x.id) as any).c;
    expect(q("token_usage")).toBe(0);
    expect(q("session_ingestion")).toBe(0);
    expect(q("tool_calls")).toBe(0);
    expect(q("audit_logs")).toBe(0);
  });
});
