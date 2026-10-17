import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigSchema, type Config } from "./schema.js";
import { getStateDir, getWorkspaceDir } from "./path.js";
import { modelChain, resolveVisionModel } from "./models.js";
export function loadConfig(overrides?: Partial<Config>): Config {
  loadEnvFile(path.join(getStateDir(), ".env"));
  const fileConfig = loadConfigFile();
  const envConfig = loadEnvOverrides();
  const merged = {
    ...fileConfig,
    ...envConfig,
    // providers 按 provider 逐个合并，避免 env 的 apiKey 覆盖掉文件里的 baseUrl
    providers: {
      ...(fileConfig.providers as object | undefined),
      ...(envConfig.providers as object | undefined),
    },
    ...overrides,
  };
  const config = ConfigSchema.parse(merged);

  // OpenClaw 方案归一化：model 选择（含 alias）优先于 defaultModel；
  // 解析后写回，所有下游调用方（repl/server/channels）自动受益
  config.defaultModel = modelChain(config)[0];
  config.visionModel = resolveVisionModel(config);

  if (!config.stateDir) {
    config.stateDir = getStateDir();
  }
  // 工作区：未配置时默认 ~/.easy-agent/workspace（env 可覆盖）
  if (!config.workspaceDir || config.workspaceDir === ".") {
    config.workspaceDir = getWorkspaceDir();
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  return config;
}
function loadConfigFile(): Record<string, unknown> {
  // 优先级：全局状态目录 > 项目目录 > 老版 XDG 路径（向后兼容）
  const paths = [
    path.join(getStateDir(), "easy-agent.json"),
    path.join(process.cwd(), "easy-agent.json"),
    path.join(process.cwd(), "easy-agent.jsonc"),
    path.join(os.homedir(), ".config", "easy-agent", "config.json"),
  ];
  for (const configPath of paths) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      const cleaned = content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      return JSON.parse(cleaned);
    } catch {}
  }
  return {};
}

/**
 * 简单 .env 解析：KEY=VALUE 注入 process.env（不覆盖已存在的变量）。
 * 让打包后的二进制在任意目录都能读到 ~/.easy-agent/.env 里的密钥。
 */
function loadEnvFile(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadEnvOverrides(): Partial<Config> {
  const overrides: any = {};
  const providerKeys: Record<string, string> = {
    OPENAI_API_KEY: "openai",
    ANTHROPIC_API_KEY: "anthropic",
    GOOGLE_API_KEY: "google",
  };
  const providerBaseUrls: Record<string, string> = {
    OPENAI_BASE_URL: "openai",
    ANTHROPIC_BASE_URL: "anthropic",
    GOOGLE_BASE_URL: "google",
  };
  for (const [envVar, providerName] of Object.entries(providerKeys)) {
    const key = process.env[envVar];
    if (key) {
      overrides.providers = overrides.providers ?? {};
      overrides.providers[providerName] = {
        ...overrides.providers[providerName],
        apiKey: key,
      };
    }
  }
  for (const [envVar, providerName] of Object.entries(providerBaseUrls)) {
    const url = process.env[envVar];
    if (url) {
      overrides.providers = overrides.providers ?? {};
      overrides.providers[providerName] = {
        ...overrides.providers[providerName],
        baseUrl: url,
      };
    }
  }
  if (process.env.EASY_AGENT_MODEL) {
    overrides.defaultModel = process.env.EASY_AGENT_MODEL;
  }
  if (process.env.EASY_AGENT_STATE_DIR) {
    overrides.stateDir = process.env.EASY_AGENT_STATE_DIR;
  }
  return overrides;
}
