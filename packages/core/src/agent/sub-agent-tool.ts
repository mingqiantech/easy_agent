import { z } from "zod";
import type { Tool, ToolContext } from "../tool/types.js";
import type { SubAgentManager } from "./sub-agent.js";

/** 目标 agent 运行时（跨 agent 控制用） */
export interface AgentDispatchTarget {
  model: string;
  workspaceDir: string;
  memory: { buildSystemPrompt(): Promise<string> };
}

export function createSubAgentTool(
  subAgents: SubAgentManager,
  getAgents?: () => Record<string, AgentDispatchTarget>,
): Tool {
  return {
    name: "sub-agent",
    description: `派生子 Agent 执行独立任务，运行留痕（Web 界面「🤖 子代理」拓扑可查）。
适合：复杂搜索、代码审查、并行分析等。
传 tasks 数组可并发执行多个子任务；子 Agent 有自己的会话和工具集，完成后返回结果。`,
    inputSchema: z.object({
      task: z.string().optional().describe("单个任务描述"),
      tasks: z
        .array(z.string())
        .optional()
        .describe("多个任务，并发执行（共用 system_prompt/tools）"),
      agent: z.string().optional().describe("派给配置中的具名 agent（继承其模型/人格/工作区），如 writer"),
      model: z.string().optional().describe("模型（默认用目标 agent 或父 Agent 的模型）"),
      system_prompt: z.string().describe("子 Agent 的系统提示"),
      tools: z.array(z.string()).optional().describe("允许使用的工具列表"),
    }),

    async execute(input: any, ctx: ToolContext) {
      const list: string[] = input.tasks?.length
        ? input.tasks
        : input.task
          ? [input.task]
          : [];
      if (!list.length) throw new Error("需要 task 或 tasks");

      // 跨 agent 控制：派给配置中的具名 agent，继承其模型/人格提示/工作区
      let target: AgentDispatchTarget | undefined;
      if (input.agent) {
        target = getAgents?.()?.[input.agent];
        if (!target)
          throw new Error(
            `unknown agent "${input.agent}"，可用：${(getAgents ? Object.keys(getAgents()) : []).join(", ") || "(无)"}`,
          );
      }

      const mk = () => ({
        model: input.model ?? target?.model,
        systemPrompt: input.system_prompt,
        allowedTools: input.tools,
        parentSessionId: ctx.sessionId,
        parentAgent: ctx.agentId,
        agentId: input.agent,
        workDir: target?.workspaceDir,
      });

      if (list.length === 1) {
        const cfg = target
          ? { ...mk(), systemPrompt: await target.memory.buildSystemPrompt() }
          : mk();
        const { sessionId } = subAgents.spawn(cfg);
        const result = await subAgents.run(sessionId, list[0]!, cfg);
        return {
          response: result.response,
          steps: result.steps,
          toolCalls: result.toolCalls.length,
          sessionId: result.sessionId,
        };
      }

      const results = await subAgents.runParallel(
        list.map((t) => ({ task: t, config: mk() })),
      );
      return {
        parallel: true,
        results: results.map((r) => ({
          response: r.response,
          steps: r.steps,
          toolCalls: r.toolCalls.length,
          sessionId: r.sessionId,
        })),
      };
    },
  };
}
