import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../src/database.js";
import { SessionManager } from "../src/session.js";
import { LLMClient } from "@easy-agent/llm/client";
import {
  createRun,
  finishRun,
  listRuns,
  runningCount,
} from "../src/agent/runs.js";

describe("sub_agent_runs（子代理运行记录）", () => {
  let sessions: SessionManager;

  beforeAll(() => {
    getDatabase(":memory:");
    sessions = new SessionManager(new LLMClient({ providers: {} }), {
      defaultModel: "test/model",
    });
  });

  it("createRun → running；finishRun → ok 并带统计", () => {
    const parent = sessions.create({ agentId: "coder" });
    const child = sessions.create({ agentId: "coder" });
    const runId = createRun({
      parentSessionId: parent.id,
      parentAgent: "coder",
      childSessionId: child.id,
      task: "审查 src/app.ts 的错误处理",
      model: "test/model",
    });
    expect(runningCount()).toBeGreaterThanOrEqual(1);

    finishRun(runId, "ok", { steps: 3, toolCalls: 2, totalTokens: 1234 });
    const rows = listRuns(20);
    const row = rows.find((r) => r.id === runId)!;
    expect(row.status).toBe("ok");
    expect(row.steps).toBe(3);
    expect(row.tool_calls).toBe(2);
    expect(row.total_tokens).toBe(1234);
    expect(row.parent_agent).toBe("coder");
    expect(row.finished_at).toBeGreaterThan(0);
  });

  it("error 状态同样留痕", () => {
    const child = sessions.create({ agentId: "default" });
    const runId = createRun({
      parentAgent: "default",
      childSessionId: child.id,
      task: "boom",
    });
    finishRun(runId, "error", { steps: 1, toolCalls: 0, totalTokens: 10 });
    const row = listRuns(50).find((r) => r.id === runId)!;
    expect(row.status).toBe("error");
  });

  it("listRuns 按时间倒序、limit 生效", () => {
    const all = listRuns(200);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.started_at).toBeGreaterThanOrEqual(all[i]!.started_at);
    }
    expect(listRuns(1).length).toBeLessThanOrEqual(1);
  });

  it("子代理会话不混入 agent 会话列表（专属拓扑视图呈现）", () => {
    const visible = sessions.create({ agentId: "writer" });
    const child = sessions.create({ agentId: "writer" });
    createRun({
      parentAgent: "writer",
      childSessionId: child.id,
      task: "生成大纲",
    });
    const ids = sessions.list(100, "writer").map((x) => x.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(child.id);
  });

  it("task 超长截断存储", () => {
    const child = sessions.create({ agentId: "default" });
    const runId = createRun({
      childSessionId: child.id,
      task: "x".repeat(600),
    });
    const row = listRuns(50).find((r) => r.id === runId)!;
    expect(row.task.length).toBeLessThanOrEqual(500);
  });
});
