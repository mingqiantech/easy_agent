import path from "node:path";
import os from "node:os";

export function getStateDir(): string {
  return (
    process.env.EASY_AGENT_STATE_DIR ??
    path.join(os.homedir(), ".local", "share", "esay-agent")
  );
}
export function getDbPath(): string {
  return path.join(getStateDir(), "agent.db");
}
export function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "easy-agent", "config.json");
}
