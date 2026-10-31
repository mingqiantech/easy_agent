import { z } from "zod";
import { getDatabase } from "../database.js";
import type { Tool, ToolContext } from "../tool/types.js";

/** 被查询 agent 需要的运行时字段（与 sub-agent-tool 的 dispatch 目标同源） */
export interface AgentStatusTarget {
  model: string;
  description?: string;
  watchAgents?: string[];
}

/**
 * agent_status：跨 agent 监视查询（2026-10-31 elf「都加」）。
 * 权限：查别人必须在自己 watchAgents 名单里（"*"=全部）；查自己永远允许。
 * 数据全部来自现有台账表（active_turns/sessions/sub_agent_runs），零 LLM 成本。
 */
export function createAgentStatusTool(
  getAgents: () => Record<string, AgentStatusTarget>,
): Tool {
  return {
    name: "agent_status",
    description: `查看其他 agent 的运行状态（监视用）：在跑哪个会话、进行到第几步/哪个工具、多久没动静、最近子任务。
权限：只能查自己 watchAgents 配置里（或 "*"）授权的对象；缺省 agent=列出全部可查对象。`,
    inputSchema: z.object({
      agent: z.string().optional().describe("目标 agent 名；缺省=我有权监视的全部"),
    }),
    async execute(input: any, ctx: ToolContext) {
      const agents = getAgents();
      const me = agents[ctx.agentId];
      const watch = (me?.watchAgents ?? []) as string[];
      const allowed = (t: string) =>
        t === ctx.agentId || watch.includes(t) || watch.includes("*");
      if (input.agent && !agents[input.agent])
        throw new Error(
          `unknown agent "${input.agent}"，可用：${Object.keys(agents).join(", ")}`,
        );
      if (input.agent && !allowed(input.agent))
        throw new Error(
          `无权限监视 "${input.agent}"：需在你的 agents.<name>.watchAgents 里加入该名字或 "*"`,
        );
      const names: string[] = input.agent
        ? [input.agent]
        : Object.keys(agents).filter((n) => allowed(n));
      const db = getDatabase();
      const now = Date.now();
      const out = names.map((nm) => {
        const turns = db
          .prepare(
            `SELECT at.session_id, at.steps_done, at.current_tool, at.started_at, s.title
             FROM active_turns at JOIN sessions s ON s.id = at.session_id
             WHERE s.agent_id = ?`,
          )
          .all(nm) as any[];
        const last = db
          .prepare(`SELECT MAX(updated_at) t FROM sessions WHERE agent_id = ?`)
          .get(nm) as any;
        const runs = db
          .prepare(
            `SELECT status, task, target_agent, started_at FROM sub_agent_runs
             WHERE parent_agent = ? ORDER BY started_at DESC LIMIT 3`,
          )
          .all(nm) as any[];
        return {
          agent: nm,
          busy: turns.length > 0,
          working: turns.map((t) => ({
            session: t.title ?? t.session_id,
            step: t.steps_done,
            tool: t.current_tool ?? null,
            runningSec: Math.max(0, Math.round((now - t.started_at) / 1000)),
          })),
          lastActiveSecAgo: last?.t
            ? Math.max(0, Math.round((now - last.t) / 1000))
            : null,
          recentRuns: runs.map((r) => ({
            status: r.status,
            task: String(r.task).slice(0, 60),
            to: r.target_agent ?? null,
            ageSec: Math.max(0, Math.round((now - r.started_at) / 1000)),
          })),
        };
      });
      return { output: out };
    },
  };
}
