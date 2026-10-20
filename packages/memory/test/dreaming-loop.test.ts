import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-dream-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { ShortTermMemory } from "../src/short-term.js";
import { lightDreaming, deepDreaming } from "../src/dreaming.js";

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
    };
    await expect(lightDreaming(deps)).rejects.toThrow("402");
    // 游标没动：新消息下个周期还能被取到
    const after = db.prepare("SELECT state FROM dreaming_state WHERE phase='light'").get() as any;
    expect(JSON.parse(after?.state ?? "{}")?.cursor ?? 0).toBe(prevCursor);
  });
});
