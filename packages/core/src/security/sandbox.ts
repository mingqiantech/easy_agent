import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

export interface SandboxOptions {
  workDir: string;
  timeout: number;
  maxOutput: number;
  envWhitelist?: string[]; // 允许传入的环境变量
}

/**
 * 在受限环境中执行命令
 */
export async function sandboxExec(
  command: string,
  options: SandboxOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { workDir, timeout, maxOutput } = options;

  // 创建临时目录作为沙箱（可选：用 Docker 隔离更安全）
  const sandboxDir = path.join(workDir, ".sandbox");
  await fs.mkdir(sandboxDir, { recursive: true });

  // 环境变量过滤
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    TERM: "dumb",
    LANG: process.env.LANG ?? "C.UTF-8",
  };

  // 白名单环境变量
  if (options.envWhitelist) {
    for (const key of options.envWhitelist) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd: sandboxDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // 进程限制
      // 在 Linux 上可以用 ulimit
    });

    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout * 1000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < maxOutput) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < maxOutput) stderr += d.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? -1,
      });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: e.message, exitCode: -1 });
    });

    child.stdin.end();
  });
}
