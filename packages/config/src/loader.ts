import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigSchema, type Config } from "./schema.js";
export function loadConfig(overrides?: Partial<Config>): Config {
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
  if (!config.stateDir) {
    config.stateDir = path.join(os.homedir(), ".local", "share", "easy-agent");
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  return config;
}
function loadConfigFile(): Record<string, unknown> {
  const paths = [
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
