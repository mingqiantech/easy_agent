import { getDatabase } from "../database.js";
import { generateId, now } from "../utils.js";

export type SubAgentRunStatus = "running" | "ok" | "error";

export interface CreateRunInput {
  parentSessionId?: string;
  parentAgent?: string;
  childSessionId: string;
  /** 跨 agent 派活时的目标 agent 名（泛 sub-agent 池=undefined）；持久化一份，
   * 防子会话被清理后拓扑边无处可查（2026-10-31） */
  targetAgent?: string;
  task: string;
  model?: string;
}

export interface SubAgentRunRow {
  id: string;
  parent_session_id: string | null;
  parent_agent: string | null;
  child_session_id: string;
  target_agent: string | null;
  task: string;
  model: string | null;
  status: SubAgentRunStatus;
  steps: number;
  tool_calls: number;
  total_tokens: number;
  started_at: number;
  finished_at: number | null;
}

export function createRun(input: CreateRunInput): string {
  const db = getDatabase();
  const id = generateId();
  db.prepare(
    `INSERT INTO sub_agent_runs
     (id, parent_session_id, parent_agent, child_session_id, target_agent, task, model, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(
    id,
    input.parentSessionId ?? null,
    input.parentAgent ?? null,
    input.childSessionId,
    input.targetAgent ?? null,
    input.task.slice(0, 500),
    input.model ?? null,
    now(),
  );
  return id;
}

export function finishRun(
  id: string,
  status: "ok" | "error",
  r: { steps: number; toolCalls: number; totalTokens: number },
): void {
  getDatabase()
    .prepare(
      `UPDATE sub_agent_runs
       SET status = ?, steps = ?, tool_calls = ?, total_tokens = ?, finished_at = ?
       WHERE id = ?`,
    )
    .run(status, r.steps, r.toolCalls, r.totalTokens, now(), id);
}

export function listRuns(limit = 50): SubAgentRunRow[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM sub_agent_runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 200)) as SubAgentRunRow[];
}

export function runningCount(): number {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT COUNT(*) n FROM sub_agent_runs WHERE status = 'running'")
      .get() as any)?.n ?? 0
  );
}
