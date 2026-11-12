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
  // 非置顶整场隐藏出列表（数据全留可查）；首页置顶只提知识不隐藏（2026-11-12：
  // 首页的零散旧内容由"知识文件+压缩+60天归档"三层消化，会话本体永不消失）
  if (!sess.pinned)
    db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);
  const points = (body.match(/^[-*]|^\d+\./gm) ?? []).length;
  return { file, points, archived: !sess.pinned };
}

/**
 * 蒸馏选单（2026-11-12 扩容，根治"零散会话漏网"）三类：
 * ① 沉寂 ≥idleDays 的非置顶会话（原逻辑）
 * ② 沉寂 ≥idleDays 的置顶首页（只提知识不隐藏——旧版一刀切拒绝导致
 *    video/work 首页的零散内容永不处理）
 * ③ [cron] 流水会话按体量触发（每 2h 一跑永不沉寂，200+ 条即蒸馏；
 *    归档后 cron 侧 findByTitle 会新建滚动会话）
 * 排除：仅**运行中**的子任务会话（旧版 NOT IN 全表把已完结的也永久排除，
 * 10-30 的 [子]显卡对比 32 条即漏网案例）
 */
export function listDistillCandidates(
  idleDays: number,
  cronMessages: number,
  max: number,
  db = getDatabase(), // 测试可注入独立连接，不依赖进程单例（2026-11-12 曾误写生产库）
) {
  const cutoff = Date.now() - idleDays * 86400000;
  return db
    .prepare(
      `SELECT id, agent_id, pinned FROM sessions
       WHERE status='active' AND distilled_at IS NULL
         AND id NOT IN (SELECT child_session_id FROM sub_agent_runs WHERE status='running')
         AND (
           updated_at < ?
           OR (title LIKE '[cron]%' AND
               (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) >= ?)
         )
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(cutoff, cronMessages, max) as Array<{ id: string; agent_id: string; pinned: number }>;
}

/** 自动蒸馏：见 listDistillCandidates（12h 调度搭车） */export async function autoDistillIdle(
  llm: LLMClient,
  sessions: SessionManager,
  opts: {
    idleDays: number;
    /** [cron] 流水会话条数达到即蒸馏（不等沉寂，默认 200） */
    cronMessages?: number;
    maxPerRun: number;
    agents: Record<string, { workspaceDir: string }>;
    defaultModel: string;
    log?: (m: string) => void;
  },
): Promise<number> {
  const log = opts.log ?? (() => {});
  const rows = listDistillCandidates(opts.idleDays, opts.cronMessages ?? 200, opts.maxPerRun);
  let done = 0;
  for (const r of rows) {
    const ws = opts.agents[r.agent_id]?.workspaceDir;
    if (!ws) continue;
    try {
      const res = await distillSession(llm, sessions, r.id, ws, opts.defaultModel);
      log(`🧪 蒸馏完成: ${r.agent_id}/${r.id} → ${path.basename(res.file)}（${res.points} 条知识点）`);
      done++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // 内容太少/结果过短的低价值会话：打标不再反复扫（省 12h 空转）
      if (/太少|过短/.test(msg))
        getDatabase().prepare("UPDATE sessions SET distilled_at = ? WHERE id = ?").run(Date.now(), r.id);
      log(`🧪 蒸馏跳过 ${r.id}: ${msg.slice(0, 100)}`);
    }
  }
  return done;
}

/* ── 知识修订回路（2026-11-12 elf 点单）：知识库新陈代谢 ──
 * dreaming 式周期扫 memory/knowledge/*.md：拿文件正文去混合索引捞
 * “文件写完之后”的新会话语料/知识，同主题出现更新结论时 LLM 输出
 * 修订动作 JSON，安全校验（只准改本文件、必须带修订历史头）后回写。 */

export interface ReviseAction {
  action: "revise" | "append" | "void" | "none";
  reason?: string;
  newContent?: string;
}

const REVISE_SYSTEM =
  "你是知识库修订助手。给你一份既有知识文件（Markdown）和它写完之后新产生的对话片段。" +
  "判断新内容是否推翻/补充文件里的结论：\n" +
  "- 有直接矛盾的结论 → action=revise，newContent=整份改后文件（保留原结构，改错处，" +
  "并在文件最末尾追加一行 `> 修订 <今天日期>：<一句话原因>`）\n" +
  "- 同主题的新事实/新坑但不矛盾 → action=append，newContent=在原文末尾追加 `## 补充（<日期>）` 小节后的整份文件" +
  "（并追加修订行）\n" +
  "- 新片段与文件主题无关或无信息增量 → action=none（宁缺毋滥，拿不准就 none）\n" +
  "只输出一个 JSON 对象：{\"action\":\"revise|append|none|void\",\"reason\":\"…\",\"newContent\":\"…\"}，" +
  "newContent 为空表示不改。不要输出 JSON 以外的任何文字。";

/** 单文件修订判定：返回动作；无新料/LLM 拒判/结果不合法 → none */
export async function decideRevision(
  llm: LLMClient,
  model: string,
  fileText: string,
  newSnippets: Array<{ excerpt: string; ts?: number }>,
  today: string,
): Promise<ReviseAction> {
  if (!newSnippets.length) return { action: "none" };
  const input = [
    `【知识文件（现状）】\n${fileText.slice(0, 4000)}`,
    `【文件写完后新产生的相关对话（${today} 检视）】`,
    ...newSnippets.map((s) => `---\n${String(s.excerpt).slice(0, 600)}`),
  ].join("\n\n");
  try {
    const resp = await llm.generate({
      model,
      system: REVISE_SYSTEM,
      messages: [{ role: "user", content: input }],
      generation: { maxTokens: 2000 },
    });
    let text = String(resp.content ?? "").trim();
    // 剥围栏
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
    if (fence) text = fence[1]!;
    const j = JSON.parse(text) as ReviseAction;
    if (!["revise", "append", "void", "none"].includes(j.action)) return { action: "none" };
    if (j.action === "none") return j;
    if (j.action === "void") return { action: "void", reason: j.reason };
    const body = String(j.newContent ?? "").trim();
    // 安全闸门：结果必须保留原文件的标题行（防 LLM 写成摘要/换题），且足够长
    const firstHeading = /^#\s.+/m.exec(fileText)?.[0]?.trim();
    if (body.length < fileText.length * 0.3 || (firstHeading && !body.includes(firstHeading.slice(0, 20))))
      return { action: "none" };
    return { action: j.action, reason: j.reason, newContent: body };
  } catch {
    return { action: "none" };
  }
}

/** 回写（调用方已过闸门）：void → 文件头插作废标记；revise/append → 整体替换 */
export function applyRevision(
  file: string,
  a: ReviseAction,
  day: string,
): boolean {
  try {
    if (a.action === "void") {
      const old = fs.readFileSync(file, "utf-8");
      if (old.startsWith("<!--voided")) return false;
      fs.writeFileSync(file, `<!--voided ${day}: ${a.reason ?? "已被后续对话推翻"}-->\n${old}`);
      return true;
    }
    if ((a.action === "revise" || a.action === "append") && a.newContent) {
      if (!fs.existsSync(file)) return false; // 文件已被删：不复活
      fs.writeFileSync(file, a.newContent.endsWith("\n") ? a.newContent : a.newContent + "\n");
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 周期扫尾（每 12h 搭蒸馏调度）：每个 agent 取最近 maxPerRun 个
 * 写完后又满 minAgeDays 的知识文件 → 检索文件落盘后的新语料 → 判定 → 回写。
 * hybrid 不可用（无向量服务）时跳过——纯关键词二查信噪比太低不值得。
 */
export async function reviseKnowledgeSweep(
  llm: LLMClient,
  opts: {
    agents: Record<string, { name: string; workspaceDir: string; model?: string }>;
    hybridFor: (wsDir: string) => { search: (q: string, o?: any) => Promise<{ hits: any[] }> } | undefined;
    model: string;
    minAgeDays: number;
    maxPerRun: number;
    log?: (m: string) => void;
  },
): Promise<number> {
  const log = opts.log ?? (() => {});
  const today = new Date().toISOString().slice(0, 10);
  const minAge = opts.minAgeDays * 86400000;
  let touched = 0;
  for (const a of Object.values(opts.agents)) {
    const dir = path.join(a.workspaceDir, "memory", "knowledge");
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join(dir, f))
        .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)
        .slice(0, opts.maxPerRun);
    } catch {
      continue; // 无知识目录
    }
    for (const file of files) {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < minAge) continue; // 太新，大概率还没“后来者”
      const text = fs.readFileSync(file, "utf-8");
      if (text.startsWith("<!--voided")) continue;
      if (/修订 \d{4}-\d{2}-\d{2}/.test(text.slice(-200)) && Date.now() - st.mtimeMs < 7 * 86400000) continue; // 刚修订过
      const hybrid = opts.hybridFor(a.workspaceDir);
      if (!hybrid) continue;
      try {
        // 检索词：标题 + 正文前 200 字足够定位同主题新语料
        const query = text.split("\n").slice(0, 6).join(" ").replace(/[#>*`]/g, "").slice(0, 240);
        const { hits } = await hybrid.search(query, { limit: 8 });
        // 只要文件落盘“之后”的新料（含别的知识文件与 session-corpus 新会话）
        const fresh = (hits as any[]).filter(
          (h) => (h.ts ?? 0) > st.mtimeMs && path.resolve(h.path) !== path.resolve(file),
        );
        const act = await decideRevision(llm, opts.model, text, fresh, today);
        if (act.action === "none") continue;
        if (applyRevision(file, act, today)) {
          log(`🔄 知识修订 ${a.name}/${path.basename(file)}: ${act.action}（${(act.reason ?? "").slice(0, 60)}）`);
          touched++;
        }
      } catch (e: any) {
        log(`🔄 修订跳过 ${path.basename(file)}: ${String(e?.message).slice(0, 90)}`);
      }
    }
  }
  return touched;
}
