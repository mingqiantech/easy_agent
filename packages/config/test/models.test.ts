import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-models-test-"));
process.env.EASY_AGENT_STATE_DIR = TEST_DIR;

import { loadConfig } from "../src/loader.js";
import {
  resolveRef,
  modelChain,
  modelFallbackMap,
  resolveImageGenModelId,
} from "../src/models.js";
import type { Config } from "../src/schema.js";

const catalog = {
  "openai/qwen3.8-flash": { alias: "qwen" },
  "openai/deepseek-v3": { alias: "cheap" },
  "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
};

function fakeConfig(partial: Partial<Config>): Config {
  return {
    defaultModel: "openai/qwen3.8-flash",
    models: catalog,
    providers: {},
    stateDir: "",
    workspaceDir: ".",
    ...partial,
  } as Config;
}

describe("resolveRef", () => {
  const config = fakeConfig({});

  it("resolves alias to canonical ref", () => {
    expect(resolveRef(config, "qwen")).toBe("openai/qwen3.8-flash");
    expect(resolveRef(config, "sonnet")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("passes provider/model refs through", () => {
    expect(resolveRef(config, "openai/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
  });

  it("completes bare model id on unique catalog suffix match", () => {
    expect(resolveRef(config, "deepseek-v3")).toBe("openai/deepseek-v3");
    // 目录里没有的裸 id 原样返回
    expect(resolveRef(config, "unknown-model")).toBe("unknown-model");
  });
});

describe("modelChain", () => {
  it("falls back to defaultModel when model unset", () => {
    const config = fakeConfig({});
    expect(modelChain(config)).toEqual(["openai/qwen3.8-flash"]);
  });

  it("accepts plain string form", () => {
    const config = fakeConfig({ model: "cheap" });
    expect(modelChain(config)).toEqual(["openai/deepseek-v3"]);
  });

  it("accepts object form and resolves alias in the whole chain", () => {
    const config = fakeConfig({
      model: { primary: "qwen", fallbacks: ["sonnet", "openai/gpt-4o"] },
    });
    expect(modelChain(config)).toEqual([
      "openai/qwen3.8-flash",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4o",
    ]);
  });
});

describe("modelFallbackMap", () => {
  it("undefined when no fallbacks", () => {
    expect(modelFallbackMap(fakeConfig({}))).toBeUndefined();
  });

  it("maps primary to ordered rest", () => {
    const config = fakeConfig({
      model: { primary: "qwen", fallbacks: ["cheap", "sonnet"] },
    });
    expect(modelFallbackMap(config)).toEqual({
      "openai/qwen3.8-flash": ["openai/deepseek-v3", "anthropic/claude-sonnet-4-6"],
    });
  });
});

describe("loadConfig normalization", () => {
  const base = { providers: { openai: { apiKey: "***" } } };

  it("model object overrides defaultModel, chain[0] written back", () => {
    const config = loadConfig({
      ...base,
      models: catalog,
      model: { primary: "cheap", fallbacks: ["qwen"] },
    });
    expect(config.defaultModel).toBe("openai/deepseek-v3");
    expect(modelChain(config)[1]).toBe("openai/qwen3.8-flash");
  });

  it("legacy defaultModel still works", () => {
    const config = loadConfig({
      ...base,
      defaultModel: "openai/gpt-4o",
    });
    expect(config.defaultModel).toBe("openai/gpt-4o");
    expect(modelChain(config)).toEqual(["openai/gpt-4o"]);
  });

  it("visionModel alias resolved; defaults to chain head", () => {
    const withAlias = loadConfig({
      ...base,
      models: catalog,
      visionModel: "sonnet",
    });
    expect(withAlias.visionModel).toBe("anthropic/claude-sonnet-4-6");

    const without = loadConfig({ ...base, models: catalog });
    expect(without.visionModel).toBe("openai/qwen3.8-flash");
  });

  it("imageGenModel resolves to bare model id", () => {
    const config = loadConfig({
      ...base,
      models: catalog,
      imageGenModel: "openai/dall-e-3",
    });
    expect(resolveImageGenModelId(config)).toBe("dall-e-3");
    expect(resolveImageGenModelId(loadConfig(base))).toBeUndefined();
  });
});
