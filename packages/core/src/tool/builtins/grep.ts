import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

export const grepTool: Tool = {
  name: "grep",
  description: "在文件内容中搜索匹配（最多 200 条）。",
  inputSchema: z.object({
    pattern: z.string().describe("正则模式"),
    path: z.string().optional(),
    include: z.string().describe("文件名过滤（*.ts）"),
  }),
  async execute(input: any, ctx: ToolContext) {
    const root = input.path
      ? path.resolve(ctx.workDir, input.path)
      : ctx.workDir;
    const args = [
      "-rn",
      "--max-count=10",
      "-I",
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
    ];
    if (input.include) args.push("--include", input.include);
    args.push(input.pattern, root);

    return new Promise((resolve) => {
      const child = spawn("grep", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < 50 * 1024) stdout += d;
      });
      child.on("close", () => {
        const lines = stdout.trim().split("\n").filter(Boolean);
        resolve({
          matches: lines.slice(0, 200),
          count: lines.length,
          truncated: lines.length > 200,
        });
        setTimeout(() => child.kill(), 10000);
        child.stdin.end();
      });
    });
  },
};
