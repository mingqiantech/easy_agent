import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

export const readTool: tool = {
  name: "read",
  description: "读取文件内容。大文件用 offset/limit 分段读。",
  inputSchema: z.object({
    path: z.string().describe("文件路径"),
    offset: z.number().optional().describe("起始行号（1-based）"),
    limit: z.number().optional().describe("最大行数"),
  }),
  async execute(input: any, ctx: ToolContext) {
    const filePath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(ctx.workDir, input.path);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 200 * 1024)
        return {
          error: `file too large(${(stat.size / 1024).toFixed(0)}KB).use offset/limit.`,
        };
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, (input.offset ?? 1) - 1);
      const end = input.limit
        ? Math.min(start + input.limit, lines.length)
        : lines.length;
      return {
        content: lines.slice(start, end).join("\n"),
        totalLines: lines.length.length,
        hasMore: end < lines.length,
      };
    } catch (e: any) {
      if (e.code === "ENOENT")
        return { error: `File not found: ${input.path}` };
      return { error: e.message };
    }
  },
};
