import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

const MAX_OUTPUT = 50 * 1024;
export const bashTool: Tool = {
  name: "bash",
  description:
    "执行shell命令。返回 exitCode/stdout/stderr。超时 30s，输出截断 50KB。",
  inputSchema: z.object({
    command: z.string().describe("shell 命令"),
    workdir: z.string().optional(),
    timeout: z.number().optional().describe("超时秒数"),
  }),
  async execute(input: any, ctx: ToolContext) {
    const cwd = input.workdir
      ? path.resolve(ctx.workDir, input.workdir)
      : ctx.workDir;
    const timeoutMs = (input.timeout ?? 30) * 1000;
    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", input.command], {
        cwd,
        env: { ...process.env, TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        truncated = false,
        killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += d;
        else truncated = true;
      });
    });
  },
};
