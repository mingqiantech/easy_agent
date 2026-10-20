import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-usage-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "@easy-agent/core/database";
import { createApp } from "../src/app.js";

beforeAll(() => {
  getDatabase(process.env.EASY_AGENT_DB_PATH!);
});

function stubDeps(): any {
  return {
    llm: {}, tools: { getDefinitions: () => [], toMarkdown: () => "" },
    searcher: { search: async () => ({ hits: [] }) },
    memory: { readMemory: async () => "", writeMemory: async () => {}, buildSystemPrompt: async () => "" },
    config: { stateDir: process.env.EASY_AGENT_STATE_DIR, workspaceDir: TEST_DIR },
    agents: {},
  };
}

describe("用量 API 缓存统计", () => {
  it("totals/daily/byModel 返回缓存列与命中率", async () => {
    const db = getDatabase();
    const now = Date.now();
    const sid = "usage-cache-test";
    db.prepare(
      `INSERT INTO sessions (id,title,agent_id,model,created_at,updated_at) VALUES (?,'u','default','m',?,?)`,
    ).run(sid, now, now);
    const ins = db.prepare(
      `INSERT INTO token_usage (session_id,model,prompt_tokens,completion_tokens,total_tokens,cached_read_tokens,cached_write_tokens,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    // 1000 输入中 800 命中缓存
    ins.run(sid, "m-flash", 1000, 100, 1100, 800, 50, now);
    ins.run(sid, "m-flash", 500, 50, 550, 0, 0, now);
    ins.run(sid, "m-max", 200, 20, 220, 100, 0, now);

    const app = createApp(stubDeps());
    const j = await (await app.request("/api/usage?days=7")).json() as any;
    expect(j.totals.prompt).toBe(1700);
    expect(j.totals.cacheRead).toBe(900);
    expect(j.totals.cacheWrite).toBe(50);
    expect(j.totals.cacheHitRate).toBeCloseTo(900 / 1700, 4);
    const today = j.daily[j.daily.length - 1];
    expect(today.cacheRead).toBe(900);
    const flash = j.byModel.find((x: any) => x.model === "m-flash");
    expect(flash.cacheRead).toBe(800);
  });

  it("无缓存数据时 cacheHitRate 为 null（UI 不显示误导性 0%）", async () => {
    const db = getDatabase();
    db.prepare("DELETE FROM token_usage").run();
    const app = createApp(stubDeps());
    const j = await (await app.request("/api/usage?days=7")).json() as any;
    expect(j.totals.cacheHitRate).toBeNull();
    expect(j.totals.cacheRead).toBe(0);
  });

  it("旧库升级：token_usage 缓存列存在且默认 0", () => {
    const cols = getDatabase().prepare("PRAGMA table_info(token_usage)").all() as any[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("cached_read_tokens");
    expect(names).toContain("cached_write_tokens");
  });
});
