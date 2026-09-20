import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, Toolcontext } from "../types.js";

export const editTool: Tool = {
  name: "edit",
  description: "精确替换文件中的文本。oldText 必须唯一匹配。",
  inputSchema: z.object({
    path: z.string().describe("文件路径"),
    oldText: z.string().describe("被替换文本（唯一匹配）"),
    newText: z.string().describe("替换后文本"),
  }),
  async execute(input: any, ctx: ToolContext) {
    const filePath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(ctx.workDir, input.path);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const count = content.split(input.oldText).length - 1;
      if (count === 0) return { error: "oldText not found" };
      if (count > 1)
        return { error: `oldText matches ${count} times, must be unique` };
      await fs.writeFile(
        filePath,
        content.replace(input.oldText, input.newText),
        "utf-8",
      );
      return { replacements: 1 };
    } catch (e: any) {
      if (e.code == "ENOENT") return { error: `File not found: ${input.path}` };
      return { error: e.message };
    }
  },
};
