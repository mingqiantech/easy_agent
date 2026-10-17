import { describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from "../src/settings.js";

describe("settings 存储（梦境调度配置）", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-settings-"));
  });

  it("无文件返回默认值（默认关闭定时梦境）", () => {
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.dreaming.enabled).toBe(false);
  });

  it("保存后读回一致", () => {
    saveSettings(dir, { dreaming: { enabled: true, intervalMinutes: 180 } });
    const s = loadSettings(dir);
    expect(s.dreaming.enabled).toBe(true);
    expect(s.dreaming.intervalMinutes).toBe(180);
  });

  it("部分字段缺失回退默认", () => {
    fs.writeFileSync(
      path.join(dir, "settings.json"),
      JSON.stringify({ dreaming: { enabled: true } }),
    );
    const s = loadSettings(dir);
    expect(s.dreaming.enabled).toBe(true);
    expect(s.dreaming.intervalMinutes).toBe(
      DEFAULT_SETTINGS.dreaming.intervalMinutes,
    );
  });

  it("损坏文件静默回退默认（网关不因设置崩）", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{oops");
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
  });
});
