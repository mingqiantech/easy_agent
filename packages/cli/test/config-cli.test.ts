import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// CLI 通过 getStateDir()（尊重 EASY_AGENT_STATE_DIR）定位文件 → 测试用临时目录
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ea-config-cli-"));
process.env.EASY_AGENT_STATE_DIR = DIR;
fs.writeFileSync(
  path.join(DIR, "easy-agent.json"),
  `{
  // 手写注释与 ${"占位符"} 都要能过 CLI 解析
  "defaultModel": "openai/gpt",
  "wecom": { "botId": "abc123", "secret": "zzz-abc-123" },
  "agents": {}
}
`,
  "utf-8",
);

const cli = path.join(import.meta.dir, "../src/entry.ts");
const run = (...args: string[]) =>
  Bun.spawnSync(["bun", cli, "config", ...args], {
    env: { ...process.env, EASY_AGENT_STATE_DIR: DIR },
  });

describe("easy-agent config CLI（bash 配置入口）", () => {
  it("get 读标量/对象；不存在返回码 1", () => {
    const r = run("get", "wecom.botId");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe("abc123");
    const o = run("get", "wecom");
    expect(JSON.parse(o.stdout.toString()).secret).toBe("zzz-abc-123");
    expect(run("get", "no.such.key").exitCode).toBe(1);
  });

  it("set 写嵌套路径并自动备份；show 脱敏", () => {
    const r = run("set", "wecom.agentId", "tech");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("easy-agent-wecom.service"); // 消费方提示
    const data = JSON.parse(fs.readFileSync(path.join(DIR, "easy-agent.json"), "utf-8"));
    expect(data.wecom.agentId).toBe("tech");
    expect(fs.readdirSync(DIR).filter((f) => f.includes(".bak-config-")).length).toBe(1);
    const show = run("show").stdout.toString();
    expect(show).toContain("***"); // secret 已掩
    expect(show).not.toContain("zzz-abc-123");
  });

  it("set 建新路径 / unset 删键", () => {
    run("set", "memorySearch.hybrid.enabled", "false");
    const data = JSON.parse(fs.readFileSync(path.join(DIR, "easy-agent.json"), "utf-8"));
    expect(data.memorySearch.hybrid.enabled).toBe(false);
    expect(run("unset", "memorySearch.hybrid.enabled").exitCode).toBe(0);
    const data2 = JSON.parse(fs.readFileSync(path.join(DIR, "easy-agent.json"), "utf-8"));
    expect("enabled" in data2.memorySearch.hybrid).toBe(false);
  });

  it("数字/JSON 值按类型入库", () => {
    run("set", "dreaming.lightMaxMsgs", "1500");
    const data = JSON.parse(fs.readFileSync(path.join(DIR, "easy-agent.json"), "utf-8"));
    expect(data.dreaming.lightMaxMsgs).toBe(1500); // number 非字符串
  });
});
