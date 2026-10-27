import fs from "node:fs";
import path from "node:path";

/** 网关设置：存 <stateDir>/settings.json，Web 设置页读写，调度器每分钟热加载 */
export interface Settings {
  dreaming: { enabled: boolean; intervalMinutes: number };
  backup: { enabled: boolean; intervalHours: number; keep: number };
}

export const DEFAULT_SETTINGS: Settings = {
  // 2026-10-27：分层改造后梦境默认开启；周期 360→120 分钟（重活成本主要在 deep 的 LLM，频率仍可控）
  dreaming: { enabled: true, intervalMinutes: 120 },
  backup: { enabled: true, intervalHours: 24, keep: 7 },
};

export function loadSettings(stateDir: string): Settings {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "settings.json"), "utf-8"),
    );
    return {
      dreaming: { ...DEFAULT_SETTINGS.dreaming, ...(raw.dreaming ?? {}) },
      backup: { ...DEFAULT_SETTINGS.backup, ...(raw.backup ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(stateDir: string, s: Settings): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "settings.json"),
    JSON.stringify(s, null, 2),
  );
}
