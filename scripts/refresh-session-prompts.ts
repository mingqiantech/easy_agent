// 一次性迁移：把所有存量会话头部的工作区快照刷成最新（2026-10-31 memory 注入修复配套）
import { getDatabase } from "../packages/core/src/database.js";
import { SessionManager } from "../packages/core/src/session.js";
import { BasicMemory } from "../packages/core/src/memory/basic.js";
import { LLMClient } from "../packages/llm/src/client.js";

const db = getDatabase(process.env.DB ?? "/home/zero/.easy-agent/agent.db");
const sm = new SessionManager(new LLMClient({ providers: {} }), { defaultModel: "x" });
sm.setSystemPromptProvider(async (id: string) => {
  const dir = id === "default" ? "/home/zero/.easy-agent/workspace" : `/home/zero/.easy-agent/workspaces/${id}`;
  return await new BasicMemory(dir).buildSystemPrompt();
});
const rows = db.prepare("SELECT id, agent_id FROM sessions").all() as any[];
for (const r of rows) {
  const changed = await sm.refreshWorkspacePrompt(r.id);
  if (changed) console.log("refreshed:", r.agent_id, r.id);
}
console.log("done, sessions:", rows.length);
