import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../../src/database.js";
import { SessionManager } from "../../src/session.js";
import { ToolRegistry } from "../../src/tool/registry.js";
import { SubAgentManager } from "../../src/agent/sub-agent.js";

/** subagent 用量记账补缓存列（2026-11-10 修 📊 页子任务缓存失真）回归 */
describe("SubAgentManager token_usage 缓存列", () => {
  let mgr: SubAgentManager;
  let sessions: SessionManager;

  beforeAll(() => {
    getDatabase(":memory:");
    const fakeLlm: any = {
      generate: async () => ({
        content: "任务完成",
        toolCalls: undefined,
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          cacheReadTokens: 80,
          cacheWriteTokens: 5,
        },
      }),
    };
    sessions = new SessionManager(fakeLlm, { defaultModel: "t/m" });
    mgr = new SubAgentManager(sessions, new ToolRegistry(false), fakeLlm, "t/m");
  });

  it("子任务运行后 cached_read/write 落库（不再为 0）", async () => {
    const { sessionId } = mgr.spawn({ systemPrompt: "你是子任务代理", agentId: "subtest" });
    const r = await mgr.run(sessionId, "做一件事", { systemPrompt: "你是子任务代理" });
    expect(r.response).toContain("任务完成");
    const row = getDatabase()
      .prepare("SELECT * FROM token_usage WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as any;
    expect(row.cached_read_tokens).toBe(80);
    expect(row.cached_write_tokens).toBe(5);
    expect(row.prompt_tokens).toBe(100);
  });
});
