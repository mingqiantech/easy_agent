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

  // providers 按 provider 逐个字段合并（env 优先），避免 env 的 apiKey
  // 把文件里的 baseUrl/api 等字段整个替换掉
  const providersMerged: Record<string, any> = {
    ...(fileConfig.providers as object | undefined),
  };
  for (const [name, patch] of Object.entries(
    (envConfig.providers as Record<string, object>) ?? {},
  )) {
    providersMerged[name] = { ...(providersMerged[name] ?? {}), ...patch };
  }

  const merged = {
    ...fileConfig,
    ...envConfig,
    providers: providersMerged,
    ...overrides,
  };

  // 支持 ${ENV_VAR} 占位符（对齐 OpenClaw：密钥不必写死在配置文件）
  interpolateEnvRefs(merged);

  const config = ConfigSchema.parse(merged);

  // OpenClaw 方案归一化：model 选择（含 alias）优先于 defaultModel；
  // 解析后写回，所有下游调用方（repl/server/channels）自动受益
  config.defaultModel = modelChain(config)[0];
  config.visionModel = resolveVisionModel(config);

  if (!config.stateDir) {
    config.stateDir = getStateDir();
  }

  // 记住实际加载的配置文件路径（PATCH /api/agents 直接回写此文件，
  // 2026-10-31 废掉 agents-state.json 双层结构）；无文件时缺省全局路径
  config.configPath = findConfigPath() ?? path.join(config.stateDir, "easy-agent.json");

  // 2026-10-31 废掉 agents-state.json 双层结构：Web UI 的 PATCH /api/agents
  // 直接回写 easy-agent.json 的 agents 节（含 default），此处不再叠加覆盖层

  // 工作区：未配置时默认 ~/.easy-agent/workspace（env 可覆盖）
  if (!config.workspaceDir || config.workspaceDir === ".") {
    config.workspaceDir = getWorkspaceDir();
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(config.workspaceDir, { recursive: true });
  return config;
}
function findConfigPath(): string | null {
  // 优先级：全局状态目录 > 项目目录 > 老版 XDG 路径（向后兼容）
  const paths = [
    path.join(getStateDir(), "easy-agent.json"),
    path.join(process.cwd(), "easy-agent.json"),
    path.join(process.cwd(), "easy-agent.jsonc"),
    path.join(os.homedir(), ".config", "easy-agent", "config.json"),
  ];
  return paths.find((p) => fs.existsSync(p)) ?? null;
}

function loadConfigFile(): Record<string, unknown> {
  const configPath = findConfigPath();
  if (!configPath) return {};
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(stripJsonComments(content));
  } catch {
    return {};
  }
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

/**
 * 字符串安全的 JSONC 注释剥离：仅去掉引号外的行注释（//）与块注释，
 * 不会破坏 "https://..." 这类字段值。
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 把 "${VAR}" 引用替换为环境变量值（仅处理 providers 下的字符串字段） */
function interpolateEnvRefs(merged: any): void {
  const ENV_REF = /\$\{([A-Z0-9_]+)\}/g;
  const subst = (s: string) =>
    s.replace(ENV_REF, (_, varName) => process.env[varName] ?? "");
  for (const p of Object.values<any>(merged.providers ?? {})) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.apiKey === "string") p.apiKey = subst(p.apiKey);
    if (typeof p.baseUrl === "string") p.baseUrl = subst(p.baseUrl);
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
