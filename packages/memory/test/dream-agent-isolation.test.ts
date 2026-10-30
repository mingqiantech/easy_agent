import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-dream-iso-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { ShortTermMemory } from "../src/short-term.js";
import { lightDreaming, deepDreaming } from "../src/dreaming.js";

const xdb = freshDatabase(process.env.EASY_AGENT_DB_PATH!);

function seed(agent: string, sid: string, role: string, content: string) {
  xdb
    .prepare(
      `INSERT OR IGNORE INTO sessions (id, title, agent_id, model, created_at, updated_at)
       VALUES (?, ?, ?, 'test', ?, ?)`,
    )
    .run(sid, `会话-${agent}`, agent, Date.now(), Date.now());
  xdb
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`msg-${Math.random().toString(36).slice(2)}`, sid, role, content, Date.now());
}

function depsFor(agent: string, memory: { current: string }) {
  const shortTerm = new ShortTermMemory(xdb);
  return {
    db: xdb,
    shortTerm,
    agent,
    llmGenerate: async () => "• 该 agent 专属事实，足够长以供提取通过质量闸门",
    readMemory: async () => memory.current,
    writeMemory: async (c: string) => {
      memory.current = c;
    },
    maskSecret: (t: string) => t,
  };
}

describe("Dreaming 多工作区完全隔离（2026-10-30）", () => {
  it("light 只扫本 agent 会话的消息，提取行打 agent 标签", async () => {
    seed("iso-a", "s-iso-a", "user", "iso-a 用户的偏好吃辣的，家里常备辣椒酱");
    seed("iso-b", "s-iso-b", "user", "iso-b 用户最近在学钢琴，买了电钢");

    const memA = { current: "# L1\n" };
    const r = await lightDreaming(depsFor("iso-a", memA), { maxMsgs: 100 });
    expect(r.processed).toBeGreaterThan(0);
    expect(r.extracted).toBe(1);

    const rowsA = new ShortTermMemory(xdb).getActive("iso-a");
    const rowsB = new ShortTermMemory(xdb).getActive("iso-b");
    expect(rowsA.length).toBe(1);
    expect(rowsB.length).toBe(0); // b 的消息绝不能被 a 的轻眠提取
  });

  it("游标按 agent 分区独立推进", () => {
    const pa = xdb
      .prepare("SELECT state FROM dreaming_state WHERE phase='light:iso-a'")
      .get() as any;
    const pb = xdb
      .prepare("SELECT state FROM dreaming_state WHERE phase='light:iso-b'")
      .get() as any;
    expect(JSON.parse(pa.state).cursor).toBeGreaterThan(0);
    expect(pb).toBeNull(); // iso-b 还没跑过 light
  });

  it("deep 晋升只写本 agent 的 MEMORY.md，不碰别人的池", async () => {
    const memA = { current: "# L1\n" };
    const deps = depsFor("iso-a", memA);
    // 预热：addImportant 走 a 的池
    deps.shortTerm.addImportant("a 家专属：吃辣", "test", "iso-a");
    const res = await deepDreaming(deps);
    expect(res.promoted).toBeGreaterThan(0);
    expect(memA.current).toContain("吃辣");

    // b 的空池跑 deep：不应把 a 的行晋升进 b 的 MEMORY.md
    const memB = { current: "# L1\n" };
    const resB = await deepDreaming(depsFor("iso-b", memB));
    expect(resB.promoted).toBe(0);
    expect(memB.current).not.toContain("吃辣");
  });

  it("存量迁移：agent 列缺省回填 default", () => {
    const n = (
      xdb.prepare("SELECT COUNT(*) c FROM short_term_memory WHERE agent IS NULL").get() as any
    ).c;
    expect(n).toBe(0);
  });
});
