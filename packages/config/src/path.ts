import path from "node:path";
import os from "node:os";

/**
 * 统一路径解析（产品化布局，OpenClaw 风格）
 *
 * ~/.easy-agent/               状态目录（EASY_AGENT_STATE_DIR 覆盖）
 *   easy-agent.json            全局配置
 *   agent.db                   数据库
 *   backups/                   备份
 *   workspace/                 工作区（EASY_AGENT_WORKSPACE 覆盖）
 *     MEMORY.md / USER.md / AGENTS.md / memory/
 */
export function getStateDir(): string {
  return process.env.EASY_AGENT_STATE_DIR ?? path.join(os.homedir(), ".easy-agent");
}

export function getDbPath(): string {
  return path.join(getStateDir(), "agent.db");
}

export function getWorkspaceDir(): string {
  return (
    process.env.EASY_AGENT_WORKSPACE ?? path.join(getStateDir(), "workspace")
  );
}

/** 全局配置文件路径（用户可放 easy-agent.json 到这里） */
export function getConfigPath(): string {
  return path.join(getStateDir(), "easy-agent.json");
}
