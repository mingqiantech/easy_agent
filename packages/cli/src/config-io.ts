import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "@easy-agent/config/path";
import { stripJsonComments } from "@easy-agent/config/loader";

/** CLI 专用：按 loadConfigFile 同款优先级定位 easy-agent.json 并解析为可写对象 */
export function loadConfigFileForCli(): { path: string; data: Record<string, unknown> } {
  const candidates = [
    path.join(getStateDir(), "easy-agent.json"),
    path.join(process.cwd(), "easy-agent.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let data: Record<string, unknown>;
    try {
      // 配置文件常有 // 注释（手写习惯），与 loader 同款先剥再解析
      data = JSON.parse(stripJsonComments(fs.readFileSync(p, "utf-8")));
    } catch (e: any) {
      console.error(`❌ ${p} 解析失败: ${String(e?.message).slice(0, 120)}`);
      process.exit(1);
    }
    return { path: p, data };
  }
  // 不存在则用 stateDir 默认位置（set 时直接创建）
  return { path: candidates[0], data: {} };
}
