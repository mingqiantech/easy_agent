import { z } from "zod";
import type { Tool, ToolContext } from "../tool/types.js";
import type { SubAgentManager } from "./sub-agent.js";

export function createSubAgentTool(subAgents: SubAgentManager): Tool {
  return {
    name: "sub-agent",
    description: `派生子 Agent 执行独立任务。
适合：复杂搜索、代码审查、并行分析等。
子 Agent 有自己的会话和工具集，完成后返回结果。`,
    inputSchema: z.object({
      task: z.string().describe("子 Agent 要执行的任务描述"),
      model: z.string().optional().describe("模型（默认用主 Agent 的模型）"),
      system_prompt: z.string().describe("子 Agent 的系统提示"),
      tools: z.array(z.string()).optional().describe("允许使用的工具列表"),
    }),

    async execute(input: any, ctx: ToolContext) {
      const { sessionId } = subAgents.spawn({
        model: input.model,
        systemPrompt: input.system_prompt,
        allowedTools: input.tools,
      });

      const result = await subAgents.run(sessionId, input.task, {
        model: input.model,
        systemPrompt: input.system_prompt,
        allowedTools: input.tools,
      });

      return {
        response: result.response,
        steps: result.steps,
        toolCalls: result.toolCalls.length,
        sessionId: result.sessionId,
      };
    },
  };
}
