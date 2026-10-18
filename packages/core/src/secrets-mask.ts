import fs from "node:fs";
import path from "node:path";

let secrets: string[] = [];

/**
 * 密钥屏蔽（OpenClaw secrets vault 的本地化版本）：
 * 从 <stateDir>/.env 收集密钥值（≥12 字符），工具输出进入对话历史前
 * 统一替换为 ***——模型和 Web 界面永远看不到明文，落库的也是掩码。
 */
export function initSecretMask(stateDir: string): void {
  const vals = new Set<string>();
  const keys: string[] = [];
  try {
    const raw = fs.readFileSync(path.join(stateDir, ".env"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      keys.push(m[1]!);
      const v = m[2]!.replace(/^["']|["']$/g, "");
      if (v.length >= 12) vals.add(v);
    }
  } catch {
    // 无 .env 文件
  }
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.length >= 12) vals.add(v);
  }
  // 长值优先替换，避免短值先吃掉长值的一部分
  secrets = [...vals].sort((a, b) => b.length - a.length);
}

/** 把文本中已知密钥值替换为 ***；未初始化时是恒等函数 */
export function maskSecrets(text: string): string {
  if (!secrets.length || !text) return text;
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join("***");
  }
  return out;
}
