import fs from "node:fs";
import path from "node:path";
import { loadConfigFileForCli } from "./config-io.js";

/**
 * easy-agent config <show|get|set|unset> [dot.path] [json值]
 * 对 ~/.easy-agent/easy-agent.json 做 CLI 级读改（bash 可脚本化，替代手改 JSON）。
 * 写入前自动备份 .bak-config-<ts>；注释不保留（原注释行会丢，文件本就应视为数据非文档）。
 */

const SENSITIVE = /key|token|secret|password|botid|appid/i;

function maskDeep(v: any): any {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      out[k] = SENSITIVE.test(k) && typeof x === "string" && x
        ? `${x.slice(0, 4)}***(${x.length})`
        : maskDeep(x);
    return out;
  }
  return v;
}

function parsePath(p: string): string[] {
  return p.split(".").filter(Boolean);
}

function getByPath(obj: any, keys: string[]): any {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

export function runConfigCli(args: string[]): number {
  const [cmd, ...rest] = args;
  const file = loadConfigFileForCli();

  if (cmd === "show" || !cmd) {
    console.log(JSON.stringify(maskDeep(file.data), null, 2));
    console.error(`\n# 文件: ${file.path}（show 已脱敏；get 返回原值）`);
    return 0;
  }

  if (cmd === "get") {
    const v = getByPath(file.data, parsePath(rest[0] ?? ""));
    if (v === undefined) {
      console.error(`未找到: ${rest[0]}`);
      return 1;
    }
    console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    return 0;
  }

  if (cmd === "set") {
    const [p, rawVal] = rest;
    if (!p || rawVal === undefined) {
      console.error("用法: config set <dot.path> <json值|string>");
      return 1;
    }
    let value: unknown;
    try {
      value = JSON.parse(rawVal);
    } catch {
      value = rawVal; // 非 JSON → 按字符串
    }
    const keys = parsePath(p);
    let cur: Record<string, unknown> = file.data;
    for (const k of keys.slice(0, -1)) {
      const nxt = cur[k];
      if (nxt == null || typeof nxt !== "object" || Array.isArray(nxt)) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (!last) {
      console.error("path 不能为空");
      return 1;
    }
    cur[last] = value;
    const bak = `${file.path}.bak-config-${Date.now()}`;
    fs.copyFileSync(file.path, bak);
    fs.writeFileSync(file.path, JSON.stringify(file.data, null, 2) + "\n", "utf-8");
    console.log(`✓ ${p} = ${rawVal}`);
    console.log(`  备份: ${path.basename(bak)}`);
    // 消费方提示：wecom.* 归通道服务，其余归网关
    const svc = p.startsWith("wecom.") ? "easy-agent-wecom.service" : "easy-agent.service";
    console.log(`  ⚠️ 重启生效: systemctl --user restart ${svc}`);
    return 0;
  }

  if (cmd === "unset") {
    const keys = parsePath(rest[0] ?? "");
    const parent = getByPath(file.data, keys.slice(0, -1));
    if (!parent || typeof parent !== "object" || !(keys[keys.length - 1] in parent)) {
      console.error(`未找到: ${rest[0]}`);
      return 1;
    }
    delete parent[keys[keys.length - 1]];
    const bak = `${file.path}.bak-config-${Date.now()}`;
    fs.copyFileSync(file.path, bak);
    fs.writeFileSync(file.path, JSON.stringify(file.data, null, 2) + "\n", "utf-8");
    console.log(`✓ 已删除 ${rest[0]}（备份 ${path.basename(bak)}）`);
    console.log(`  ⚠️ 重启生效: systemctl --user restart easy-agent.service`);
    return 0;
  }

  console.error("用法: easy-agent config [show|get <path>|set <path> <值>|unset <path>]");
  return 1;
}
