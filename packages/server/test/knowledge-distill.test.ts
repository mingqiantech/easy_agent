import { describe, it, expect } from "bun:test";

const { collectDistillInput } = await import("../src/knowledge.js");

describe("collectDistillInput（蒸馏输入清洗）", () => {
  it("剔工具轮/system/巡检流水/空轮；assistant JSON 取 text；剥图片音频标记", () => {
    const msgs = [
      { role: "system", content: "工作区快照" },
      { role: "user", content: "怎么配 CAN 波特率" },
      { role: "assistant", content: JSON.stringify({ text: "BRP 分频对齐 80% 采样点", toolCalls: [{ name: "bash" }] }) },
      { role: "tool", content: '{"result":"..."}' },
      { role: "assistant", content: "![接线图](/uploads/show-abc.png)\n[[audio_as_voice]]\n按图接即可" },
      { role: "user", content: "F4 系列呢" },
      { role: "assistant", content: "F405 同 IP，APB1 42MHz 下 SJW=1/TMS=8/BRS=15 也 1Mbps" },
      { role: "user", content: "收到，整理个要点" },
      { role: "assistant", content: "要点：位时序 8~16tq、采样点 75-87.5%、先示波验证再上总线" },
      { role: "user", content: "✅ 巡检正常（一句话概要）" },
      { role: "assistant", content: "   " },
    ] as any;
    const out = collectDistillInput(msgs)!;
    expect(out).toContain("👤 怎么配 CAN 波特率");
    expect(out).toContain("BRP 分频");
    expect(out).toContain("[接线图]"); // markdown 图降级为 alt 文本
    expect(out).not.toContain("audio_as_voice");
    expect(out).not.toContain("巡检正常");
    expect(out).not.toContain("result"); // 工具轮丢弃
  });

  it("有效内容 <6 条 → null（不值得蒸馏）", () => {
    expect(collectDistillInput([{ role: "user", content: "hi" }] as any)).toBeNull();
    expect(collectDistillInput([])).toBeNull();
  });

  it("输入预算封顶（超长截 24k 内）", () => {
    const long = Array.from({ length: 60 }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(1500) }) as any);
    const out = collectDistillInput(long)!;
    expect(out.length).toBeLessThanOrEqual(25000);
  });
});


// ===== 选单扩容测试（2026-11-12）：独立 :memory: 连接，绝不吃进程单例 =====
// （背景：_gd() 无参版本在单独跑本文件时会把测试数据写进生产 agent.db，已发生过）
import { Database } from "bun:sqlite";
import { listDistillCandidates } from "../src/knowledge.js";

describe("listDistillCandidates 选单扩容", () => {
  function freshDb() {
    const d = new Database(":memory:");
    d.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, agent_id TEXT, model TEXT,
      status TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, distilled_at INTEGER, distill_skip_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER);
      CREATE TABLE sub_agent_runs (id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT,
      task TEXT, model TEXT, status TEXT, started_at INTEGER, finished_at INTEGER);`);
    return d;
  }

  it("沉寂非置顶✓ 沉寂置顶✓ cron 超体量✓ 完结子任务✓；运行中子任务/近期/小 cron 排除；已蒸馏不重复", () => {
    const db = freshDb();
    const now = Date.now();
    const old = now - 11 * 86400000;
    const mk = (id: string, title: string, pinned: number, upd: number, msgs: number) => {
      db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at) VALUES (?,?,'a','m','active',?,?,?)")
        .run(id, title, pinned, 1, upd);
      for (let i = 0; i < msgs; i++)
        db.prepare("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,'user','x',?)").run(id + "-" + i, id, upd);
    };
    mk("idle-normal", "专题会话", 0, old, 8);
    mk("idle-pinned", "首页", 1, old, 30);
    mk("cron-huge", "[cron] work-watch-agents", 0, now, 210);
    mk("cron-small", "[cron] other", 0, now, 50);
    mk("fresh", "昨天还在聊", 0, now - 86400000, 3);
    mk("child-running", "[子] 在跑", 0, old, 5);
    db.prepare("INSERT INTO sub_agent_runs (id,parent_session_id,child_session_id,task,model,status,started_at) VALUES ('r1','p','child-running','t','m','running',?)").run(now);
    mk("child-done", "[子] 完结", 0, old, 5);
    db.prepare("INSERT INTO sub_agent_runs (id,parent_session_id,child_session_id,task,model,status,started_at,finished_at) VALUES ('r2','p','child-done','t','m','ok',?,?)").run(now, now);

    const picked = new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id));
    expect(picked.has("idle-normal")).toBe(true);
    expect(picked.has("idle-pinned")).toBe(true);   // 首页纳入蒸馏（不隐藏）
    expect(picked.has("cron-huge")).toBe(true);     // 体量触发
    expect(picked.has("child-done")).toBe(true);    // 完结子任务不再被永久排除
    expect(picked.has("child-running")).toBe(false);
    expect(picked.has("cron-small")).toBe(false);
    expect(picked.has("fresh")).toBe(false);
    db.prepare("UPDATE sessions SET distilled_at=? WHERE id='idle-normal'").run(now);
    expect(new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id)).has("idle-normal")).toBe(false);
    // 重试冷却：skip 近期排除；冷却过期（>3d）的回来
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at,distill_skip_at) VALUES ('skip-hot','x','a','m','active',0,1,?,?)").run(now - 11*86400000, now);
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at,distill_skip_at) VALUES ('skip-cold','x','a','m','active',0,1,?,?)").run(now - 11*86400000, now - 4*86400000);
    const p2 = new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id));
    expect(p2.has("skip-hot")).toBe(false);
    expect(p2.has("skip-cold")).toBe(true);
  });
});
