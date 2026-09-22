import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import type { Tool, ToolContext } from "../types.js";
export const globTool: Tool = {
  name: "glob",
  description: "用 glob 模式搜索文件路径（最多 500 个）。",
  inputSchema: z.object({
    pattern: z.object().describe("glob 模式（如 **/*.ts）"),
    path: z.string().optional(),
  }),
  async execute(input: any, ctx: ToolContext) {
    const root = input.path
      ? path.resolve(ctx.workDir, input.path)
      : ctx.workDir;
    const re = new RegExp(
      "^" +
        input.pattern
          .replace(/\./g, "\\.")
          .replace(/\*\*/g, "<<<G>>>")
          .replace(/\*/g, "[^/]")
          .replace(/<<<G>>>/g, ".*")
          .replace(/\?/g, "[^/]") +
        "$",
    );
    const files: string[] = [];
    async function walk(dir: string, rel: string) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name == "node_modules") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isFile() && re.test(r)) files.push(r);
        else if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      }
    }
    await walk(root, "");
    return {
      files: files.sort().slice(0, 500),
      count: files.length,
      truncated: files.length > 500,
    };
  },
};
