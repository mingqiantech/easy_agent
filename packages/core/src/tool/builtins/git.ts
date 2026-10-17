import { z } from "zod";
import { spawn } from "node:child_process";
import type { Tool, ToolContext } from "../types.js";

const GitInput = z.object({
  action: z
    .enum([
      "status",
      "diff",
      "log",
      "add",
      "commit",
      "push",
      "pull",
      "branch",
      "checkout",
      "merge",
      "stash",
      "create-branch",
    ])
    .describe("Git 操作"),
  args: z.array(z.string()).optional().describe("附加参数"),
  message: z.string().optional().describe("提交消息（commit 时使用）"),
});

/** 明确禁止的危险组合 */
const BLOCKED = ["push --force", "push -f", "reset --hard", "clean -fd", "filter-branch"];

function runGit(gitArgs: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", gitArgs, {
      cwd,
      env: { ...process.env, TERM: "dumb" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 50 * 1024) stdout += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 10 * 1024) stderr += d;
    });

    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? -1 }));
    child.on("error", (e) => resolve({ stdout: "", stderr: e.message, code: -1 }));
    child.stdin.end();
  });
}

/**
 * git 工具（Week 9）
 * 只读操作直通；写操作走白名单动作；危险组合硬拒。
 */
export const gitTool: Tool = {
  name: "git",
  description: `执行 Git 操作。
安全操作：status, diff, log, branch, add, commit, stash
需要仓库有远程：push, pull
危险操作（force push / reset --hard / clean -fd）被阻止。`,
  inputSchema: GitInput,

  async execute(input: any, ctx: ToolContext) {
    const cmdStr = `${input.action} ${(input.args ?? []).join(" ")}`;
    if (BLOCKED.some((b) => cmdStr.includes(b))) {
      return { error: `Blocked dangerous git operation: ${cmdStr}` };
    }

    let gitArgs: string[];
    switch (input.action) {
      case "status":
        gitArgs = ["status", "--short", "--branch"];
        break;
      case "diff":
        gitArgs = ["diff", "--stat", ...(input.args ?? [])];
        break;
      case "log":
        gitArgs = ["log", "--oneline", "-20", ...(input.args ?? [])];
        break;
      case "add":
        gitArgs = ["add", ...(input.args ?? ["."])];
        break;
      case "commit":
        if (!input.message) return { error: "commit requires a message" };
        gitArgs = ["commit", "-m", input.message];
        break;
      case "push":
        gitArgs = ["push", ...(input.args ?? [])];
        break;
      case "pull":
        gitArgs = ["pull", ...(input.args ?? [])];
        break;
      case "branch":
        gitArgs = ["branch", ...(input.args ?? [])];
        break;
      case "checkout":
        gitArgs = ["checkout", ...(input.args ?? [])];
        break;
      case "merge":
        gitArgs = ["merge", ...(input.args ?? [])];
        break;
      case "stash":
        gitArgs = ["stash", ...(input.args ?? [])];
        break;
      case "create-branch":
        if (!input.args?.length) return { error: "create-branch requires a branch name in args" };
        gitArgs = ["checkout", "-b", ...input.args];
        break;
      default:
        return { error: `Unknown git action: ${input.action}` };
    }

    const result = await runGit(gitArgs, ctx.workDir);
    return {
      action: input.action,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
};
