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
    expect(out.length).toBeLessThanOrEqual(42000);
  });
});

// ===== 选单扩容 + 就地换届测试（2026-11-12）：独立 :memory: 连接，绝不吃进程单例 =====
// （背景：_gd() 无参版本在单独跑本文件时会把测试数据写进生产 agent.db，已发生过）
import { Database } from "bun:sqlite";
import { archiveOlderThan, listDistillCandidates } from "../src/knowledge.js";

function freshDb() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, agent_id TEXT, model TEXT,
    status TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER, distilled_at INTEGER, distill_skip_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, metadata TEXT DEFAULT '{}', created_at INTEGER);
    CREATE TABLE messages_archive (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
    metadata TEXT, created_at INTEGER, archived_at INTEGER);
    CREATE TABLE sub_agent_runs (id TEXT PRIMARY KEY, parent_session_id TEXT, child_session_id TEXT,
    task TEXT, model TEXT, status TEXT, started_at INTEGER, finished_at INTEGER);`);
  return d;
}

describe("listDistillCandidates 选单扩容", () => {
  it("沉寂非置顶✓ 沉寂置顶✓ cron 超体量✓ 完结子任务✓；运行中子任务/近期/小 cron 排除；已蒸馏不重复；skip 冷却", () => {
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

    let picked = new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id));
    expect(picked.has("idle-normal")).toBe(true);
    expect(picked.has("idle-pinned")).toBe(true);   // 首页纳入蒸馏（就地换届不隐藏）
    expect(picked.has("cron-huge")).toBe(true);     // 体量触发
    expect(picked.has("child-done")).toBe(true);    // 完结子任务不再被永久排除
    expect(picked.has("child-running")).toBe(false);
    expect(picked.has("cron-small")).toBe(false);
    expect(picked.has("fresh")).toBe(false);

    // 已蒸馏的非置顶不再出现
    db.prepare("UPDATE sessions SET distilled_at=? WHERE id='idle-normal'").run(now);
    picked = new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id));
    expect(picked.has("idle-normal")).toBe(false);

    // 首页周期性换届：蒸馏后又有新活动且重新沉寂 → 再入单；蒸馏后无新活动 → 不重复
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at,distilled_at) VALUES ('home-again','首页','a','m','active',1,?,?,?)").run(1, now - 11 * 86400000, now - 15 * 86400000);
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at,distilled_at) VALUES ('home-stale','首页','a','m','active',1,?,?,?)").run(1, now - 11 * 86400000, now - 2 * 86400000);
    picked = new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id));
    expect(picked.has("home-again")).toBe(true);
    expect(picked.has("home-stale")).toBe(false);

    // transient 失败冷却：近期 skip 排除；冷却过期回来
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at,distill_skip_at) VALUES ('skip-hot','x','a','m','active',0,?,?,?)").run(now - 11 * 86400000, now - 11 * 86400000, now);
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at,distill_skip_at) VALUES ('skip-cold','x','a','m','active',0,?,?,?)").run(now - 11 * 86400000, now - 11 * 86400000, now - 4 * 86400000);
    picked = new Set(listDistillCandidates(10, 200, 50, db as any).map((x) => x.id));
    expect(picked.has("skip-hot")).toBe(false);
    expect(picked.has("skip-cold")).toBe(true);
  });
});

describe("archiveOlderThan（换届搬运：只动 cutoff 前）", () => {
  it("旧消息入归档；头部与十天内对话原位保留；幂等；cutoff 推进后可继续搬", () => {
    const db = freshDb();
    db.prepare("INSERT INTO sessions (id,title,agent_id,model,status,pinned,created_at,updated_at) VALUES ('h','首页','a','m','active',1,1,1)").run();
    const ins = db.prepare("INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)");
    const now = Date.now();
    ins.run("sys1", "h", "system", "工作区头部快照", 1);
    ins.run("kp0", "h", "system", "【知识要点】旧卡", now - 20 * 86400000);
    ins.run("u1", "h", "user", "旧问题", now - 15 * 86400000);
    ins.run("a1", "h", "assistant", "旧回答", now - 12 * 86400000);
    ins.run("u2", "h", "user", "十天内的新问题", now - 86400000);
    ins.run("a2", "h", "assistant", "十天内的回答", now - 3600000);
    // cutoff=10 天前：只搬旧的（含旧知识卡），十天内的原样保留
    expect(archiveOlderThan("h", now - 10 * 86400000, db as any)).toBe(3);
    const left = db.prepare("SELECT id FROM messages WHERE session_id='h' ORDER BY created_at").all() as any[];
    expect(left.map((x) => x.id)).toEqual(["sys1", "u2", "a2"]); // 头部+近期保留
    expect((db.prepare("SELECT COUNT(*) c FROM messages_archive WHERE session_id='h'").get() as any).c).toBe(3);
    expect(archiveOlderThan("h", now - 10 * 86400000, db as any)).toBe(0); // 幂等
    // 再等 10 天：近期也够旧了，能继续搬
    expect(archiveOlderThan("h", now + 9 * 86400000, db as any)).toBe(2);
  });
});

describe("distillSession 截断续写", () => {
  it("finishReason=length 时以 assistant 前缀续写并拼接全文", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { distillSession } = await import("../src/knowledge.js");
    const { getDatabase } = await import("@easy-agent/core/database");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-cont-"));
    getDatabase(":memory:");
    const db = getDatabase();
    const now = Date.now(), DAY = 86400000;
    db.prepare("INSERT INTO sessions (id,agent_id,model,title,status,pinned,created_at,updated_at) VALUES ('csess','cont','m','续写会话','active',1,?,?)").run(now - 30 * DAY, now - 20 * DAY);
    const ins = db.prepare("INSERT INTO messages (id,session_id,role,content,metadata,created_at) VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < 8; i++)
      ins.run("c" + i, "csess", i % 2 ? "assistant" : "user", `旧对话第${i}条，内容是关于 X${i} 的参数与结论，足够长以通过清洗${"详".repeat(60)}`, "{}", now - (25 - i) * DAY);
    const segs = ["## 结论与事实\n- 前半段结论到「双 Sp", "ark 为例：约 19 tok/s。」\n", "尾巴收尾。"];
    let call = 0, lastMsgs: any;
    const llm: any = {
      generate: async (req: any) => {
        lastMsgs = req.messages;
        const out = segs[Math.min(call, 2)];
        call++;
        return { content: out, finishReason: call < 3 ? "length" : "stop" };
      },
    };
    const sm: any = { get: () => ({ id: "csess", agentId: "cont", model: "m", title: "续写会话", pinned: true, status: "active", createAt: now - 30 * DAY, updateAt: now }), getFullMessages: () => db.prepare("SELECT * FROM messages WHERE session_id='csess' ORDER BY created_at").all() };
    const r = await distillSession(llm, sm, "csess", dir, "m", 10);
    expect(call).toBe(3);
    expect(r.points).toBeGreaterThanOrEqual(1);
    const kp = db.prepare("SELECT content FROM messages WHERE session_id='csess' AND content LIKE '【知识要点】%'").get() as any;
    expect(kp.content).toContain("前半段结论到「双 Spark 为例"); // 断点无缝拼接
    expect(kp.content).toContain("尾巴收尾");
    // 续写请求带 assistant 前缀 + 继续指令
    expect(lastMsgs.some((m: any) => m.role === "assistant")).toBe(true);
    // 文件也是全文
    const f = r.file;
    expect(fs.readFileSync(f, "utf-8")).toContain("尾巴收尾");
  });
});

describe("packChunks / mergeKnowledgeSections（map-reduce 分块与合并）", () => {
  it("packChunks 按行边界切块不丢行；小块不切", async () => {
    const { packChunks } = await import("../src/knowledge.js");
    const lines = Array.from({ length: 100 }, (_, i) => `👤 第${i}条 ${"x".repeat(200)}`);
    const chunks = packChunks(lines, 1000);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join("\n").split("\n").length).toBe(100);
    expect(chunks.every((c) => c.length <= 1000 + 220)).toBe(true);
    expect(packChunks(["a", "b"], 9000)).toEqual(["a\nb"]);
  });

  it("mergeKnowledgeSections：同名节合并、异名节保序、散行归 preamble", async () => {
    const { mergeKnowledgeSections } = await import("../src/knowledge.js");
    const text = [
      "## 显卡",
      "- A 结论",
      "## 横向经验",
      "- 坑1",
      "## 显卡",
      "- B 结论",
      "## 接线",
      "- C 结论",
    ].join("\n");
    const out = mergeKnowledgeSections(text);
    expect(out.match(/^## /gm)).toHaveLength(3); // 显卡/横向经验/接线，重名归一
    expect(out).toContain("## 显卡\n- A 结论\n- B 结论"); // 同节内容并在一起
    expect(out.indexOf("## 接线")).toBeGreaterThan(out.indexOf("## 显卡"));
  });
});
