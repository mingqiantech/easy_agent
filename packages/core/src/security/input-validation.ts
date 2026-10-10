/**
 * 危险命令检测
 */
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+-rf\s+\//, reason: "rm -rf / 会删除根目录" },
  { pattern: /mkfs\./, reason: "格式化磁盘" },
  { pattern: /dd\s+if=.*of=\/dev\//, reason: "直接写磁盘设备" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: "fork bomb" },
  { pattern: /chmod\s+-R\s+777\s+\//, reason: "全局 777 权限" },
  { pattern: /curl\s+.*\|\s*sh/, reason: "管道执行远程脚本" },
  { pattern: /wget\s+.*\|\s*bash/, reason: "管道执行远程脚本" },
];

export function checkCommandSafety(command: string): {
  safe: boolean;
  warnings: string[];
  blocked: string[];
} {
  const warnings: string[] = [];
  const blocked: string[] = [];

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      blocked.push(reason);
    }
  }

  // 警告（不阻止，但提醒）
  if (/sudo\s/.test(command)) warnings.push("使用了 sudo");
  if (/>\/dev\/sd[a-z]/.test(command)) warnings.push("写入磁盘设备");
  if (/nc\s+-l/.test(command)) warnings.push("监听网络端口");

  return {
    safe: blocked.length === 0,
    warnings,
    blocked,
  };
}

/**
 * 路径安全检查
 */
export function isPathSafe(filePath: string, workDir: string): boolean {
  const resolved = path.resolve(filePath);
  const normalizedWorkDir = path.resolve(workDir);

  // 不允许访问工作目录之外（除非是绝对路径且在允许列表中）
  if (!resolved.startsWith(normalizedWorkDir)) {
    return false;
  }

  // 禁止访问敏感路径
  const forbidden = ["/etc/shadow", "/etc/passwd", "/.ssh", "/.env"];
  for (const f of forbidden) {
    if (resolved.includes(f)) return false;
  }

  return true;
}

import path from "node:path";
