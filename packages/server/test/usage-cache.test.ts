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
    // 在效口径：只算真走了缓存的行（1000+200=1200），不被无缓存行稀释
    expect(j.totals.promptCacheable).toBe(1200);
    expect(j.totals.cacheHitRateActive).toBeCloseTo(900 / 1200, 4);
    const today = j.daily[j.daily.length - 1];
    expect(today.cacheRead).toBe(900);
    expect(today.promptCacheable).toBe(1200);
    const flash = j.byModel.find((x: any) => x.model === "m-flash");
    expect(flash.cacheRead).toBe(800);
  });

  it("无缓存数据时 cacheHitRate 为 null（UI 不显示误导性 0%）", async () => {
    const db = getDatabase();
    db.prepare("DELETE FROM token_usage").run();
    const app = createApp(stubDeps());
    const j = await (await app.request("/api/usage?days=7")).json() as any;
    expect(j.totals.cacheHitRate).toBeNull();
    expect(j.totals.cacheHitRateActive).toBeNull();
    expect(j.totals.cacheRead).toBe(0);
  });

  it("旧库升级：token_usage 缓存列存在且默认 0", () => {
    const cols = getDatabase().prepare("PRAGMA table_info(token_usage)").all() as any[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("cached_read_tokens");
    expect(names).toContain("cached_write_tokens");
  });
});

describe("用量 API 计费成本", () => {
  it("cost=定价行成本之和；NULL 行（未知定价）不参与且全未知时 cost=null", async () => {
    const db = getDatabase();
    db.prepare("DELETE FROM token_usage").run();
    const now = Date.now();
    const sid = "usage-cost-test";
    db.prepare(
      `INSERT INTO sessions (id,title,agent_id,model,created_at,updated_at) VALUES (?,'c','default','qwen3.8-flash',?,?)`,
    ).run(sid, now, now);
    const ins = db.prepare(
      `INSERT INTO token_usage (session_id,model,prompt_tokens,completion_tokens,total_tokens,cached_read_tokens,cached_write_tokens,cost_usd,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    // 已知定价：1M 输入全未缓存 + 1M 输出 = $2.5 + $10
    ins.run(sid, "qwen3.8-flash", 1_000_000, 1_000_000, 2_000_000, 0, 0, 12.5, now);
    // 未知定价模型：cost NULL，不计入
    ins.run(sid, "ollama-local", 5000, 100, 5100, 0, 0, null, now);

    const app = createApp(stubDeps());
    const j = await (await app.request("/api/usage?days=7")).json() as any;
    expect(j.totals.cost).toBeCloseTo(12.5, 6);
    const flash = j.byModel.find((x: any) => x.model === "qwen3.8-flash");
    expect(flash.cost).toBeCloseTo(12.5, 6);
    const local = j.byModel.find((x: any) => x.model === "ollama-local");
    expect(local.cost).toBeNull();
    const agent = j.byAgent.find((x: any) => x.agent === "default");
    expect(agent.cost).toBeCloseTo(12.5, 6);
    const today = j.daily[j.daily.length - 1];
    expect(today.cost).toBeCloseTo(12.5, 6);
  });

  it("全部无定价时 totals.cost=null", async () => {
    const db = getDatabase();
    db.prepare("DELETE FROM token_usage").run();
    const app = createApp(stubDeps());
    const j = await (await app.request("/api/usage?days=7")).json() as any;
    expect(j.totals.cost).toBeNull();
  });

  it("token_usage 有 cost_usd 列", () => {
    const cols = getDatabase().prepare("PRAGMA table_info(token_usage)").all() as any[];
    expect(cols.map((c) => c.name)).toContain("cost_usd");
  });
});
