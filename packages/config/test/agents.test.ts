import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-agents-test-"));
process.env.EASY_AGENT_STATE_DIR = TEST_DIR;

import { resolveAgents, resolveRef } from "../src/models.js";
import type { Config } from "../src/schema.js";

const catalog = {
  "openai/qwen3.8-flash": { alias: "flash" },
  "openai/qwen3.8-max": { alias: "max" },
};

function fakeConfig(partial: Partial<Config>): Config {
  return {
    defaultModel: "openai/qwen3.8-flash",
    models: catalog,
    providers: {},
    stateDir: "",
    workspaceDir: "/home/dia/.easy-agent/workspace",
    agents: {},
    ...partial,
  } as Config;
}

describe("resolveAgents（多 Agent）", () => {
  it("always includes default agent with primary model + global workspace", () => {
    const list = resolveAgents(fakeConfig({}));
    expect(list.length).toBe(1);
    expect(list[0]).toEqual({
      name: "default",
      model: "openai/qwen3.8-flash",
      workspaceDir: "/home/dia/.easy-agent/workspace",
      description: "默认助手",
      thinking: "off",
    });
  });

  it("config agents appended; model alias resolved; defaults inherited", () => {
    const config = fakeConfig({
      agents: {
        coder: { description: "编程助手", model: "max" },
        writer: { workspaceDir: "/tmp/ws-writer" },
      },
    });
    const list = resolveAgents(config);
    expect(list.map((a) => a.name)).toEqual(["default", "coder", "writer"]);

    const coder = list[1];
    expect(coder.model).toBe("openai/qwen3.8-max");
    expect(coder.description).toBe("编程助手");
    expect(coder.workspaceDir).toBe("/home/dia/.easy-agent/workspace"); // 继承

    const writer = list[2];
    expect(writer.model).toBe("openai/qwen3.8-flash"); // 继承主模型
    expect(writer.workspaceDir).toBe("/tmp/ws-writer");
    expect(writer.description).toBe("writer"); // 缺省用名字
  });

  it("model selection feeds default agent", () => {
    const config = fakeConfig({
      model: { primary: "cheap", fallbacks: [] },
      models: { ...catalog, "openai/deepseek-v3": { alias: "cheap" } },
    });
    const list = resolveAgents(config);
    expect(list[0].model).toBe("openai/deepseek-v3");
  });

  it("thinking: per-agent override > thinkingDefault; reasoning:false 自动降级", () => {
    const config = fakeConfig({
      thinkingDefault: "low",
      models: {
        ...catalog,
        "openai/qwen-nothink": { alias: "nothink", reasoning: false },
      },
      agents: {
        smart: { model: "max", thinking: "high" },
        basic: {},
        nope: { model: "openai/qwen-nothink", thinking: "high" },
      },
    } as any);
    const list = resolveAgents(config);
    expect(list[0]!.thinking).toBe("low"); // default 继承全局
    expect(list[1]!.thinking).toBe("high"); // agent 独立覆盖
    expect(list[2]!.thinking).toBe("low"); // 缺省继承全局
    expect(list[3]!.thinking).toBe("off"); // 模型不支持 → 降级
  });

  it("thinkingDefault 缺省为 off（向后兼容：无 thinking 配置不变行为）", () => {
    const config = fakeConfig({ agents: { x: { thinking: "medium" } } } as any);
    const list = resolveAgents(config);
    expect(list[0]!.thinking).toBe("off");
    expect(list[1]!.thinking).toBe("medium");
  });
});
