import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-models-test-"));
process.env.EASY_AGENT_STATE_DIR = TEST_DIR;

import { loadConfig, stripJsonComments } from "../src/loader.js";
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

describe("providers 进阶（OpenClaw 式自定义 provider）", () => {
  it("stripJsonComments 不破坏字符串内的 // 与 URL", () => {
    const src = [
      "{",
      "  // c https://a.example",
      '  "url": "https://x.example/v1" /* b */',
      "}",
    ].join(String.fromCharCode(10));
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed.url).toBe("https://x.example/v1");
  });

  it("overrides 的 apiKey 支持 ENV 引用；api 字段透传", () => {
    const saved = process.env.MY_GW_SECRET;
    process.env.MY_GW_SECRET = "sk-from-env";
    const ref = String.fromCharCode(36, 123) + "MY_GW_SECRET" + String.fromCharCode(125);
    const config = loadConfig({
      providers: {
        mygw: {
          apiKey: ref,
          baseUrl: "https://gw.example/v1",
          api: "openai",
        },
      },
    });
    const gw = config.providers.mygw!;
    expect(gw.apiKey).toBe("sk-from-env");
    expect(gw.api).toBe("openai");
    expect(gw.baseUrl).toBe("https://gw.example/v1");
    if (saved === undefined) delete process.env.MY_GW_SECRET;
    else process.env.MY_GW_SECRET = saved;
  });

  it("文件与 env 按 provider 字段合并：env apiKey 优先，文件 baseUrl/api 保留", () => {
    const cfgFile = [TEST_DIR, "easy-agent.json"].join("/");
    const savedK = process.env.OPENAI_API_KEY;
    const savedU = process.env.OPENAI_BASE_URL;
    const ph = String.fromCharCode(36, 123) + "OPENAI_API_KEY" + String.fromCharCode(125);
    require("node:fs").writeFileSync(
      cfgFile,
      JSON.stringify({
        providers: {
          openai: { apiKey: ph, baseUrl: "https://file.example/v1", api: "openai" },
        },
      }),
    );
    process.env.OPENAI_API_KEY = "sk-env-wins";
    delete process.env.OPENAI_BASE_URL;

    const config = loadConfig();
    const p = config.providers.openai!;
    expect(p.apiKey).toBe("sk-env-wins");
    expect(p.baseUrl).toBe("https://file.example/v1");
    expect(p.api).toBe("openai");

    if (savedK === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedK;
    if (savedU === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedU;
    require("node:fs").unlinkSync(cfgFile);
  });
});
