import fs from "node:fs";
import path from "node:path";
import type { LLMClient } from "@easy-agent/llm/client";
import type { SessionManager } from "@easy-agent/core/session";
import { getDatabase } from "@easy-agent/core/database";

/**
 * 会话知识蒸馏（2026-11-12 elf 点单）：
 * 沉寂较久的会话 → 剔除无效内容（巡检流水账/纯工具轮/系统占位）→ LLM 提炼
 * 「知识点」写入该 agent 工作区 memory/knowledge/<日期>_<标题>.md
 * → 进混合索引可检索召回 → 整场会话标 archived 从列表隐藏（数据全留可查）。
 * 自动：搭 12h 调度扫 idle ≥N 天的非置顶会话；手动：UI/API 单场蒸馏。
 */

const NOISE = /^✅ 巡检正常|^【系统恢复】|^\s*$|^\[用户发来图片\]$/;
const MIN_MESSAGES = 6; // 太短的会话没什么可蒸馏

/** 蒸馏输入清洗：保 user/assistant 文本，剔工具轮、cron 流水、占位；每条截断 */
export function collectDistillInput(
  msgs: Array<{ role: string; content: string; metadata?: any }>,
): string | null {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "tool") continue;
    let text = String(m.content ?? "").trim();
    if (!text || NOISE.test(text)) continue;
    if (m.role === "assistant") {
      // {text,toolCalls} JSON 轮：只取文本
      try {
        const p = JSON.parse(text);
        if (p && typeof p === "object") text = String(p.text ?? "").trim();
      } catch {}
      // 知识回答里的图片/音频投递标记保留 URL 无意义，剥掉标记壳
      text = text.replace(/\[\[audio[^\]]*\]\]/g, "").replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]").trim();
      if (!text || NOISE.test(text)) continue;
      lines.push(`🤖 ${text.slice(0, 800)}`);
    } else {
      lines.push(`👤 ${text.slice(0, 300)}`);
    }
    if (lines.join("\n").length > 24000) break; // 输入预算
  }
  return lines.length >= MIN_MESSAGES ? lines.join("\n") : null;
}

const KP_SYSTEM =
  "你是知识提炼助手。把下面的对话记录提炼为「知识点清单」，中文 Markdown：\n" +
  "## 结论与事实\n（每条一行，保留具体数字/命令/路径/commit 等硬信息，注明适用条件）\n" +
  "## 方法与经验\n（可复用的做法、踩过的坑）\n" +
  "## 未决问题\n（当时没解决/存疑的，没有就省略本节）\n" +
  "只写有信息量的条目，寒暄与流水账直接丢弃；总长 600 字以内。";

export interface DistillResult {
  file: string;
  points: number;
  archived: boolean;
}

export async function distillSession(
  llm: LLMClient,
  sessions: SessionManager,
  sessionId: string,
  workspaceDir: string,
  defaultModel: string,
): Promise<DistillResult> {
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error("会话不存在");
  if (sess.pinned) throw new Error("首页会话不蒸馏（滚动主会话由压缩/归档自动管理）");
  const db = getDatabase();
  const full = sessions.getFullMessages(sessionId) as any[];
  const input = collectDistillInput(full);
  if (!input) throw new Error("有效内容太少，不值得蒸馏");
  let body = "";
  for (let attempt = 0; attempt < 2 && body.length < 40; attempt++) {
    try {
      const resp = await llm.generate({
        model: sess.model || defaultModel,
        system: KP_SYSTEM,
        messages: [{ role: "user", content: input }],
        generation: { maxTokens: 1600 },
      });
      body = String(resp.content ?? "").trim();
    } catch (e: any) {
      if (attempt === 1) throw new Error(`蒸馏调用失败: ${String(e?.message).slice(0, 120)}`);
    }
  }
  if (body.length < 40)
    throw new Error(`蒸馏结果过短（${body.length} 字，已重试），放弃；原会话不动`);
  // 知识文件进 memory/knowledge/：混合索引 10min 周期自动收录（session-corpus 之外第二猎场）
  const dir = path.join(workspaceDir, "memory", "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const safe = (sess.title ?? "会话").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 30);
  let file = path.join(dir, `${day}_${safe}.md`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${day}_${safe}-${n++}.md`);
  const head = `# 知识点 · ${sess.title ?? sessionId}\n\n> 蒸馏自 ${new Date(sess.createAt ?? full[0]?.createdAt ?? Date.now()).toLocaleDateString("zh-CN")}–${new Date(sess.updateAt).toLocaleDateString("zh-CN")} 的会话（${full.length} 条），原会话已归档可查。\n\n`;
  fs.writeFileSync(file, head + body + "\n", "utf-8");
  db.prepare("UPDATE sessions SET distilled_at = ? WHERE id = ?").run(Date.now(), sessionId);
  // 整场隐藏出列表（数据全留；搜索/详情页仍可达）
  db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ? AND pinned = 0").run(sessionId);
  const points = (body.match(/^[-*]|^\d+\./gm) ?? []).length;
  return { file, points, archived: true };
}

/** 自动蒸馏：idle ≥ idleDays 且未蒸馏的非置顶 active 会话（12h 调度搭车） */
export async function autoDistillIdle(
  llm: LLMClient,
  sessions: SessionManager,
  opts: {
    idleDays: number;
    maxPerRun: number;
    agents: Record<string, { workspaceDir: string }>;
    defaultModel: string;
    log?: (m: string) => void;
  },
): Promise<number> {
  const log = opts.log ?? (() => {});
  const cutoff = Date.now() - opts.idleDays * 86400000;
  const rows = getDatabase()
    .prepare(
      `SELECT id, agent_id FROM sessions
       WHERE status='active' AND pinned=0 AND distilled_at IS NULL
         AND updated_at < ? AND id NOT IN (SELECT child_session_id FROM sub_agent_runs)
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(cutoff, opts.maxPerRun) as any[];
  let done = 0;
  for (const r of rows) {
    const ws = opts.agents[r.agent_id]?.workspaceDir;
    if (!ws) continue;
    try {
      const res = await distillSession(llm, sessions, r.id, ws, opts.defaultModel);
      log(`🧪 蒸馏完成: ${r.agent_id}/${r.id} → ${path.basename(res.file)}（${res.points} 条知识点）`);
      done++;
    } catch (e: any) {
      log(`🧪 蒸馏跳过 ${r.id}: ${String(e?.message).slice(0, 100)}`);
    }
  }
  return done;
}
