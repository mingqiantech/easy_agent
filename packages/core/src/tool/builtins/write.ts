import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
export const writeTool: tool = {
  name: "write",
  description: "写入或覆盖文件。自动创建父目录。",
  inputSchema: z.object({
    path: z.string().describe("文件路径"),
    content: z.string().describe("完整文件内容"),
  }),
  async execute(input: any, ctx: ToolContext) {
    const filePath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(ctx.workDir, input.path);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content, "utf-8");
      const stat = await fs.stat(filePath);
      return {
        path: input.path,
        bytes: stat.size,
        lines: input.content.split("\n").length,
      };
    } catch (e: any) {
      return { error: e.message };
    }
  },
};
