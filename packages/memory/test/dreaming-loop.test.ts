import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-dream-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { ShortTermMemory } from "../src/short-term.js";
import { lightDreaming, deepDreaming, remDreaming } from "../src/dreaming.js";

const xdb = freshDatabase(process.env.EASY_AGENT_DB_PATH!);

function seedMessage(role: string, content: string) {
  const db = xdb;
  const sid = "dream-test-session";
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, title, agent_id, model, created_at, updated_at)
     VALUES (?, '梦境测试', 'default', 'test', ?, ?)`,
  ).run(sid, Date.now(), Date.now());
  db
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`msg-${Math.random().toString(36).slice(2)}`, sid, role, content, Date.now());
}

describe("Dreaming 闭环：lightDreaming 提取 → 晋升", () => {
  it("light 提取事实入短期记忆，游标推进不重复处理", async () => {
    seedMessage("user", "我特别喜欢用 bun 跑 TypeScript，比 node 快多了");
    seedMessage("assistant", JSON.stringify({ text: "记住了，以后 TS 工程优先用 bun" }));
    seedMessage("user", "今天天气不错");  // 太短/闲聊，应被过滤掉
    seedMessage("tool", "raw tool noise");

    const db = xdb;
    const shortTerm = new ShortTermMemory(db);
    let memoryContent = "# Long-Term Memory\n";
    const deps = {
      db,
      shortTerm,
      llmGenerate: async (prompt: string) => {
        expect(prompt).toContain("bun");
        return "• 用户偏好 bun 跑 TypeScript\n• [重要] TS 工程优先用 bun，用户明确表过态";
      },
      readMemory: async () => memoryContent,
      writeMemory: async (c: string) => { memoryContent = c; },
      maskSecret: (t: string) => t,
    };

    const r1 = await lightDreaming(deps);
    expect(r1.processed).toBeGreaterThanOrEqual(2); // user+assistant 有效行
    expect(r1.extracted).toBe(2);
    const entries = shortTerm.getActive();
    expect(entries.length).toBe(2);
    const important = entries.find((e) => e.text.includes("明确表过态"));
    expect(important).toBeTruthy();
    expect(important!.recallCount).toBeGreaterThanOrEqual(3);
    // 普通条目不应带预热统计
    const plain = entries.find((e) => !e.text.includes("明确表过态"));
    expect(plain!.recallCount).toBe(0);
    expect(plain!.text).not.toContain("[重要]");

    // 游标已推进：没有新消息时不再调用 LLM
    let llmCalled = false;
    const r2 = await lightDreaming({ ...deps, llmGenerate: async () => { llmCalled = true; return "• 不该出现"; } });
    expect(r2.processed).toBe(0);
    expect(llmCalled).toBe(false);
    expect(shortTerm.getActive().length).toBe(2);
  });

  it("deep 把预热过的重要条目晋升进 MEMORY.md（闭环出口）", async () => {
    const db = xdb;
    const shortTerm = new ShortTermMemory(db);
    let memoryContent = "# Long-Term Memory\n\n_No memories yet._\n";
    const deps = {
      db,
      shortTerm,
      llmGenerate: async () => "用户偏好：TS 工程优先用 bun。",
      readMemory: async () => memoryContent,
      writeMemory: async (c: string) => { memoryContent = c; },
      maskSecret: (t: string) => t,
    };
    const r = await deepDreaming(deps);
    expect(r.promoted).toBe(1); // 只有 [重要] 预热条目达标
    expect(memoryContent).toContain("Promoted");
    expect(memoryContent).toContain("bun");
    // 占位行必须被清除，否则 buildSystemPrompt 的 No-memories 判断会误杀整份记忆
    expect(memoryContent).not.toContain("No memories yet");
    // 晋升后不再是活跃条目
    expect(shortTerm.getActive().length).toBe(1);
  });

  it("light 遇到 LLM 失败时游标不前进（下轮重试不丢窗口）", async () => {
    const db = xdb;
    const before = db.prepare("SELECT state FROM dreaming_state WHERE phase='light'").get() as any;
    const prevCursor = JSON.parse(before?.state ?? "{}")?.cursor ?? 0;
    seedMessage("user", "失败也要能重试，这条应该留在窗口里等待提取处理");
    const deps = {
      db,
      shortTerm: new ShortTermMemory(db),
      llmGenerate: async () => { throw new Error("402 payment required"); },
      readMemory: async () => "",
      writeMemory: async () => {},
      maskSecret: (t: string) => t,
    };
    await expect(lightDreaming(deps)).rejects.toThrow("402");
    // 游标没动：新消息下个周期还能被取到
    const after = db.prepare("SELECT state FROM dreaming_state WHERE phase='light'").get() as any;
    expect(JSON.parse(after?.state ?? "{}")?.cursor ?? 0).toBe(prevCursor);
  });
});

describe("REM 主题积累去重（2026-10-29 修复）", () => {
  it("再现主题原地更新单行不插新行；已晋升后不再积累", async () => {
    const db = xdb;
    const shortTerm = new ShortTermMemory(db);
    // 4 条活跃条目触发主题反思
    shortTerm.add("remd-A 用户偏好 bun 跑 TypeScript", "test:remd:a");
    shortTerm.add("remd-B 动态网页抓取困难", "test:remd:b");
    shortTerm.add("remd-C 需要视频生成功能", "test:remd:c");
    shortTerm.add("remd-D 配置需重启生效", "test:remd:d");
    let memory = "# Long-Term Memory\n";
    const deps: any = {
      db,
      shortTerm,
      llmGenerate: async (p: string) =>
        p.includes("归纳以下") ? "开发工具偏好|倾向使用 bun 运行 TypeScript" : "整合段",
      readMemory: async () => memory,
      writeMemory: async (c: string) => { memory = c; },
      maskSecret: (t: string) => t,
    };
    const countRows = () =>
      (db.prepare("SELECT COUNT(*) n FROM short_term_memory WHERE origin='rem:theme:开发工具偏好'").get() as any).n;

    await remDreaming(deps); // 首次：只观察
    expect(countRows()).toBe(1);
    const first = db.prepare("SELECT text FROM short_term_memory WHERE origin='rem:theme:开发工具偏好'").get() as any;
    expect(first.text).toStartWith("主题：");

    await remDreaming(deps); // 再现：原地升级为 [重要] 计数 2，不插新行
    expect(countRows()).toBe(1);
    const second = db.prepare("SELECT text, recall_count FROM short_term_memory WHERE origin='rem:theme:开发工具偏好'").get() as any;
    expect(second.text).toContain("主题积累（第2次）");
    expect(second.text).toStartWith("[重要]");
    expect(second.recall_count).toBe(3);

    // 模拟已晋升 → 再现完全跳过（MEMORY.md 已有结论，不再喂重复行）
    db.prepare("UPDATE short_term_memory SET promoted_at=? WHERE origin='rem:theme:开发工具偏好'").run(Date.now());
    await remDreaming(deps);
    expect(countRows()).toBe(1);
    const third = db.prepare("SELECT text FROM short_term_memory WHERE origin='rem:theme:开发工具偏好'").get() as any;
    expect(third.text).toContain("第2次"); // 没被改写成第3次
    // 清理本测试的行
    db.prepare("DELETE FROM short_term_memory WHERE origin LIKE 'test:remd:%' OR origin='rem:theme:开发工具偏好'").run();
  });

  it("deep 对已逐字在 L1 的 pinned 条目跳过写入（仍标记晋升）", async () => {
    const db = xdb;
    const shortTerm = new ShortTermMemory(db);
    shortTerm.addImportant("重复条目X 用户偏好 bun");
    let memory = "# Long-Term Memory\n\n## Promoted (2026-01-01)\n\n- [重要] 重复条目X 用户偏好 bun\n";
    const deps: any = {
      db, shortTerm,
      llmGenerate: async () => "不应该被调用",
      readMemory: async () => memory,
      writeMemory: async (c: string) => { memory = c; },
      maskSecret: (t: string) => t,
    };
    const r = await deepDreaming(deps);
    expect(r.promoted).toBe(1); // DB 侧照常标记
    // 不再新增重复段：Promoted 段仍只有种子里那一个
    expect((memory.match(/## Promoted/g) || []).length).toBe(1);
    expect((memory.match(/重复条目X/g) || []).length).toBe(1);
  });
});
