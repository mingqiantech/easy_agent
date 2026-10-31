import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-flags-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "@easy-agent/core/database";
import { createApp } from "../src/app.js";

beforeAll(() => {
  getDatabase(process.env.EASY_AGENT_DB_PATH!);
});

function stubDeps(): any {
  const agent: any = {
    name: "life",
    model: "p/m",
    description: "d",
    thinking: "off",
    toolsDisable: [],
    workspaceDir: TEST_DIR,
    memory: { readMemory: async () => "", writeMemory: async () => {}, buildSystemPrompt: async () => "" },
  };
  return {
    llm: {}, tools: { getDefinitions: () => [], toMarkdown: () => "", names: () => [] },
    searcher: { search: async () => ({ hits: [] }) },
    memory: agent.memory,
    config: { stateDir: process.env.EASY_AGENT_STATE_DIR, workspaceDir: TEST_DIR },
    agents: { life: agent },
  };
}

describe("PATCH /api/agents/:name 开关字段", () => {
  it("toolsDisable + toolHint 可单独 PATCH 并 GET 回显", async () => {
    const app = createApp(stubDeps());
    let r = await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolHint: "重活优先 acp_agent" }),
    });
    expect(r.status).toBe(200);
    r = await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolsDisable: ["trae_agent"] }),
    });
    expect(r.status).toBe(200);
    const j = await (await app.request("/api/agents")).json() as any;
    const life = j.agents.find((a: any) => a.name === "life");
    expect(life.toolHint).toBe("重活优先 acp_agent");
    expect(life.toolsDisable).toEqual(["trae_agent"]);
  });

  it("toolHint null 清除；类型错误 400", async () => {
    const app = createApp(stubDeps());
    await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolHint: "x" }),
    });
    const j: any = await (await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolHint: null }),
    })).json();
    expect(j.agent.toolHint).toBeUndefined();
    const bad = await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolHint: 123 }),
    });
    expect(bad.status).toBe(400);
  });

  it("PATCH 直写 easy-agent.json（2026-10-31 废双层：单一配置文件真相）", async () => {
    const app = createApp(stubDeps());
    await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolHint: "h", toolsDisable: ["acp_agent"], relatedAgents: ["default"] }),
    });
    // stubDeps 无 configPath → 回退 stateDir/easy-agent.json
    const file = path.join(process.env.EASY_AGENT_STATE_DIR!, "easy-agent.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.agents.life.toolHint).toBe("h");
    expect(data.agents.life.tools.disable).toEqual(["acp_agent"]);
    expect(data.agents.life.relatedAgents).toEqual(["default"]);
    // toolHint:null → 删除键而非写 null（写 null 会挂 schema 校验）
    await app.request("/api/agents/life", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolHint: null }),
    });
    const data2 = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect("toolHint" in data2.agents.life).toBe(false);
    expect(data2.agents.life.thinking).toBeUndefined(); // 未传的字段不动
  });
});
