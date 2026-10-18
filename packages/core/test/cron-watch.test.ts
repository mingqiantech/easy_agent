import { describe, it, expect } from "bun:test";
import { CronManager } from "../src/cron/index.js";

describe("cron watch（事件 watcher 静默检查，零 LLM 成本）", () => {
  const cron = new CronManager();

  it("输出 {fire:true} → 命中并带回消息", () => {
    const hit = cron.runWatchCheck({
      command: `printf '{"fire":true,"message":"disk low"}'`,
    });
    expect(hit).toEqual({ fire: true, message: "disk low" });
  });

  it("fire:false → 返回判定但不算命中", () => {
    const hit = cron.runWatchCheck({ command: `printf '{"fire":false}'` });
    expect(hit?.fire).toBe(false);
  });

  it("非 JSON / 空输出 / 缺 command → null（静默）", () => {
    expect(cron.runWatchCheck({ command: "echo hello" })).toBeNull();
    expect(cron.runWatchCheck({ command: "true" })).toBeNull();
    expect(cron.runWatchCheck({})).toBeNull();
  });

  it("命令失败不抛异常（watcher 坏了不该拖垮调度器）", () => {
    expect(cron.runWatchCheck({ command: "exit 1" })).toBeNull();
    expect(cron.runWatchCheck({ command: "sleep 5", timeoutMs: 200 })).toBeNull();
  });

  it("stdout 前有杂音也能解析（取首个 { 起）", () => {
    const hit = cron.runWatchCheck({
      command: `echo noisy-prefix; printf '{"fire":true}'`,
    });
    expect(hit).toEqual({ fire: true });
  });
});
