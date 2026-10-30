import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-agents-test-"));
process.env.EASY_AGENT_STATE_DIR = TEST_DIR;

import { resolveAgents, resolveRef } from "../src/models.js";
import { loadConfig } from "../src/loader.js";
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
      toolsDisable: [],
      relatedAgents: [],
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
    // 2026-10-30 完全隔离：未显式配 workspaceDir 的 agent 默认独立工作区（不再继承共享）
    expect(coder.workspaceDir).toBe("/home/dia/.easy-agent/workspace/workspaces/coder");

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

describe("agents-state.json 持久化覆盖（Web UI 设置思考等级）", () => {
  // 注意：多个测试文件都会设置 EASY_AGENT_STATE_DIR（模块加载序决定最终值），
  // 所以运行时从 env 读当前状态目录，而非模块内 TEST_DIR 常量
  const stateFile = () =>
    require("node:path").join(process.env.EASY_AGENT_STATE_DIR as string, "agents-state.json");
  const fs = require("node:fs");

  it("UI 写入的 thinking 叠加配置文件；default agent 也可被覆盖", () => {
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ agents: { coder: { thinking: "high" }, default: { thinking: "medium" } } }),
    );
    const config = loadConfig({
      models: catalog as any,
      agents: { coder: { model: "max", thinking: "low" } } as any,
    });
    const list = resolveAgents(config);
    expect(list.find((a) => a.name === "coder")!.thinking).toBe("high");
    expect(list.find((a) => a.name === "default")!.thinking).toBe("medium");
    fs.unlinkSync(stateFile());
  });

  it("无覆盖文件时配置文件值原样生效", () => {
    const config = loadConfig({
      models: catalog as any,
      agents: { coder: { thinking: "medium" } } as any,
    });
    expect(resolveAgents(config).find((a) => a.name === "coder")!.thinking).toBe("medium");
  });

  it("reasoning:false 模型上覆盖的 thinking 仍自动降级为 off", () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ agents: { plain: { thinking: "high" } } }));
    const config = loadConfig({
      models: { ...catalog, "openai/plain-model": { alias: "pm", reasoning: false } } as any,
      agents: { plain: { model: "pm" } } as any,
    });
    expect(resolveAgents(config).find((a) => a.name === "plain")!.thinking).toBe("off");
    fs.unlinkSync(stateFile());
  });
});
