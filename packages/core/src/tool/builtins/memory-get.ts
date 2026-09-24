import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
export const memoryGetTool: Tool = {
  name: "memory_get",
  description: "从记忆文件读取内容。支持 MEMORY.md, USER.md, memory/*.md。",
  inputSchema: z.object({
    path: z.string().describe("MEMORY.md / USER.md / memory/*.md"),
    from: z.number().optional(),
    lines: z.number().optional(),
  }),

  async execute(input: any, ctx: ToolContext) {
    const allowed = ["MEMORY.md", "USER.md", "SOUL.md", "IDENTITY.md"];
    if (!allowed.includes(input.path) && !input.path.startsWith("memory/"))
      return { error: `Denied. Allowed: ${allowed.join(", ")}, memory/*.md` };
    try {
      const content = await fs.readFile(
        path.resolve(ctx.workDir, input.path),
        "utf-8",
      );
      const lines = content.split("\n");
      const start = Math.max(0, (input.from ?? 1) - 1);
      const end = input.lines
        ? Math.min(start + input.lines, lines.length)
        : lines.length;
      return {
        status: "ok",
        text: lines.slice(start, end).join("\n"),
        totalLines: lines.length,
        hasMore: end < lines.length,
      };
    } catch (e: any) {
      if (e.code == "ENOENT") return { status: "not_found", text: "" };
      return { status: "error", error: e.message };
    }
  },
};
