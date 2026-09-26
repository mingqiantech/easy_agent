import { z } from "zod";
import type { Tool, Toolcontext } from "@easy-agent/core/tool/types";
import { MemorySearcher } from "./search.js";
import { ToolContext } from "../../core/src/tool";

export function createMemorySearchTool(searcher: MemorySearcher): Tool {
  return {
    name: "memory_search",
    description: `语义搜索 MEMORY.md、USER.md、memory/ 下的文件和会话历史。
在回答关于之前的工作、决策、日期、人物、偏好的问题前必须调用。`,
    inputSchema: z.object({
      query: z.string().describe("搜索查询"),
      maxResults: z.number().optional().describe("最大结果数"),
      corpus: z.enum(["memory", "sessions", "all"]).optional(),
    }),
    async execute(input: any, ctx: ToolContext) {
      return searcher.search(input.query, {
        maxResults: input.maxResults,
        corpus: input.corpus,
      });
    },
  };
}
