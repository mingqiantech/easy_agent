import fs from "node:fs";
import path from "node:path";

/** 网关设置：存 <stateDir>/settings.json，Web 设置页读写，调度器每分钟热加载 */
export interface Settings {
  dreaming: { enabled: boolean; intervalMinutes: number };
}

export const DEFAULT_SETTINGS: Settings = {
  dreaming: { enabled: false, intervalMinutes: 360 },
};

export function loadSettings(stateDir: string): Settings {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(stateDir, "settings.json"), "utf-8"),
    );
    return { dreaming: { ...DEFAULT_SETTINGS.dreaming, ...(raw.dreaming ?? {}) } };
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
