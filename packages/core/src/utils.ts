import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ulid } from "ulid";
export function generateId(): string {
  return ulid();
}
export function now(): number {
  return Date.now();
}

// ---- debug logger ----
// 终端 stderr + 持久化文件双写。路径可用 EASY_AGENT_LOG 覆盖。
const LOG_FILE =
  process.env.EASY_AGENT_LOG ||
  path.join(os.homedir(), ".local", "share", "easy-agent", "agent.log");

export function logDebug(tag: string, ...args: unknown[]): void {
  const parts = args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  const line = `[${new Date().toISOString()}] [${tag}] ${parts.join(" ")}`;
  console.error(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    // 日志写文件失败不能影响主流程
  }
}
