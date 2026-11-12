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
/** 清洗：消息→蒸馏输入行（剔工具轮/流水账/占位；assistant 取 text 剥标记） */
export function buildDistillLines(msgs: Array<{ role: string; content: string; metadata?: any }>): string[] {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "system" || m.role === "tool") continue;
    let text = String(m.content ?? "").trim();
    if (!text || NOISE.test(text)) continue;
    if (m.role === "assistant") {
      try {
        const p = JSON.parse(text);
        if (p && typeof p === "object") text = String(p.text ?? "").trim();
      } catch {}
      text = text.replace(/\[\[audio[^\]]*\]\]/g, "").replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]").trim();
      if (!text || NOISE.test(text)) continue;
      lines.push(`🤖 ${text.slice(0, 1500)}`);
    } else {
      lines.push(`👤 ${text.slice(0, 300)}`);
    }
  }
  return lines;
}

/** 兼容入口（测试/小会话用）：行拼单串；总量封顶防爆预算 */
export function collectDistillInput(
  msgs: Array<{ role: string; content: string; metadata?: any }>,
): string | null {
  const lines = buildDistillLines(msgs);
  if (lines.length < MIN_MESSAGES) return null;
  const joined = lines.join("\n");
  if (joined.length <= 40000) return joined;
  // 超长保头尾弃中段（中段多为主题已展开的讨论细节；分块蒸馏路径不受此限）
  const head = joined.slice(0, 10000);
  let tailStart = Math.max(head.length, joined.length - 30000);
  const nl = joined.indexOf("\n", tailStart);
  if (nl > 0 && nl < tailStart + 500) tailStart = nl + 1;
  return `${head}\n…（中段约 ${((tailStart - head.length) / 1000).toFixed(0)}k 字符省略）…\n${joined.slice(tailStart)}`;
}

/** 按行分块（map-reduce 的 map 单位）：每块 ≤chunkChars，主题按时间相邻自然聚合 */
export function packChunks(lines: string[], chunkChars = 9000): string[] {
  const out: string[] = [];
  let cur: string[] = [], len = 0;
  for (const l of lines) {
    if (len + l.length > chunkChars && cur.length) {
      out.push(cur.join("\n"));
      cur = []; len = 0;
    }
    cur.push(l); len += l.length + 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** 合并各块的主题小节：同名 `## X` 节合并内容（横向经验等通用节去重关键） */
export function mergeKnowledgeSections(joined: string): string {
  const order: string[] = [];
  const map = new Map<string, string[]>();
  let curTitle = "", curBuf: string[] = [];
  const flush = () => {
    if (!curTitle && !curBuf.length) return;
    const t = curTitle || "_preamble";
    if (!map.has(t)) { map.set(t, []); order.push(t); }
    map.get(t)!.push(...curBuf.filter(Boolean));
    curBuf = [];
  };
  for (const line of joined.split("\n")) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { flush(); curTitle = h[1].trim(); }
    else if (curTitle || line.trim()) curBuf.push(line);
  }
  flush();
  return order
    .map((t) => (t === "_preamble" ? map.get(t)!.join("\n") : `## ${t}\n${map.get(t)!.join("\n")}`))
    .join("\n\n");
}

/** 知识提炼生成器（含 maxTokens 截断续写：finishReason=length → assistant 前缀接着要） */
export async function generateKnowledge(
  llm: LLMClient,
  model: string,
  input: string,
): Promise<string> {
  const msgs: any[] = [{ role: "user", content: input }];
  let acc = "";
  for (let seg = 0; seg < 3; seg++) {
    const resp = await llm.generate({
      model,
      system: KP_SYSTEM,
      messages: msgs,
      generation: { maxTokens: 2600 },
    });
    acc += String(resp.content ?? "");
    if (resp.finishReason !== "length" || seg === 2) break;
    console.log(`✂️ 蒸馏输出截断，续写第 ${seg + 2} 段`);
    msgs.push(
      { role: "assistant", content: acc },
      { role: "user", content: "从断点继续只写后半截，勿重复已输出；覆盖剩余主题后收束" },
    );
  }
  return acc.trim();
}

const KP_SYSTEM =
  "你是知识提炼助手。下面的对话记录跨越多个话题，请**按对话实际主题分节**提炼，中文 Markdown：\n" +
  "- 每个主题一节 `## <主题名>`（如 `## Mac Studio 显卡选型`、`## ST3215 步进接线`、`## CAN 波特率配置`），\n" +
  "  主题名从对话内容里概括，**对话里出现过的重要话题每个都要单独成节，不许合并成一坨、不许只写一个主题**\n" +
  "- 节内条目：关键结论/数字/命令/路径等硬信息每条一行，注明适用条件；可复用的做法与踩过的坑并入同节\n" +
  "- 该主题有未解决事项时，节末加一行 `未决：…`\n" +
  "- 最后可加一节 `## 横向经验` 收纳跨主题的通用心得（没有就省略）\n" +
  "只写有信息量的内容，寒暄与流水账丢弃；**宁全勿简**——硬信息一条不许丢，篇幅随内容走；" +
  "输出前自查：按时间顺序通读对话，确保每个讨论过的主题都有对应小节。";

export interface DistillResult {
  file: string;
  points: number;
  archived: boolean;
  archivedN?: number;
}

export async function distillSession(
  llm: LLMClient,
  sessions: SessionManager,
  sessionId: string,
  workspaceDir: string,
  defaultModel: string,
  olderThanDays = 10,
): Promise<DistillResult> {
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error("会话不存在");
  const cutoff = Date.now() - olderThanDays * 86400000;
  const db = getDatabase();
  const full = sessions.getFullMessages(sessionId) as any[];
  // 只蒸 cutoff 之前的旧段落（elf 11-12 定稿）：十天内的对话保持原样继续显示/使用
  const oldMsgs = full.filter((m) => !m.archived && (m.createdAt ?? 0) < cutoff);
  const recentCts = full
    .filter((m) => !m.archived && m.role !== "system" && (m.createdAt ?? 0) >= cutoff)
    .map((m) => m.createdAt as number);
  const dLines = buildDistillLines(oldMsgs);
  if (dLines.length < MIN_MESSAGES) throw new Error(`没有 ${olderThanDays} 天前的可蒸馏内容`);
  // map-reduce：按时间块并行蒸馏（单块喂全史必然顾此失彼——11-12 实测 4 段续写
  // 仍 0 主题；分块后每块只面对 ≤9k 字符，主题小节天然完整），再按节名合并
  const chunks = packChunks(dLines);
  console.log(`🧪 蒸馏 ${chunks.length} 块（${dLines.length} 行）`);
  let body = "";
  for (let ci = 0; ci < chunks.length; ci++) {
    const part = await generateKnowledge(llm, sess.model || defaultModel, chunks[ci]);
    if (part.length >= 40) body += (body ? "\n\n" : "") + part;
    else console.warn(`🧪 块 ${ci + 1}/${chunks.length} 结果过短，跳过`);
  }
  if (body) body = mergeKnowledgeSections(body);
  if (body.length < 40)
    throw new Error(`蒸馏结果过短（${body.length} 字），放弃；原会话不动`);
  // 知识文件进 memory/knowledge/：混合索引 10min 周期自动收录（session-corpus 之外第二猎场）
  const dir = path.join(workspaceDir, "memory", "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const safe = (sess.title ?? "会话").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 30);
  let file = path.join(dir, `${day}_${safe}.md`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${day}_${safe}-${n++}.md`);
  const head = `# 知识点 · ${sess.title ?? sessionId}\n\n> 蒸馏自 ${new Date(oldMsgs[0]?.createdAt ?? sess.createAt).toLocaleDateString("zh-CN")}–${new Date(oldMsgs[oldMsgs.length - 1]?.createdAt ?? Date.now()).toLocaleDateString("zh-CN")} 的对话（${oldMsgs.length} 条，已归档可查）${recentCts.length ? `；${olderThanDays} 天内的 ${recentCts.length} 条新对话保留原样` : ""}。\n\n`;
  fs.writeFileSync(file, head + body + "\n", "utf-8");
  db.prepare("UPDATE sessions SET distilled_at = ? WHERE id = ?").run(Date.now(), sessionId);
  // 非置顶整场隐藏出列表（数据全留可查）。首页置顶就地换届（2026-11-12 elf：“不自建新页面，页面自己更新”）：
  // 不建新会话——把非 system 消息全部移入 messages_archive（UI 默认折叠可展开，搜索命中），
  // 工作区头部保留，会话继续 id 不变从干净上下文滚动；旧事实靠知识文件 + recall 召回
  // 就地换届（2026-11-12 elf 定稿）：只把 cutoff 前的旧消息移入归档表（页面不再渲染
  // 归档原文，搜索/导出仍可查）；十天内的活跃对话原位保留。知识卡插在“旧↔新”
  // 分界时间戳：页面顺序 = 头部 → 📚知识卡 → 近期对话；卡同时进 LLM 上下文
  const archivedN = archiveOlderThan(sessionId, cutoff, db);
  const cardTs = recentCts.length ? Math.min(...recentCts) - 1 : Date.now();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, metadata, created_at)
     VALUES (?, ?, 'system', ?, '{}', ?)`,
  ).run(Date.now().toString(36) + "-kp", sessionId, `【知识要点】\n${body}`, cardTs);
  // 会话隐藏仅限“无保留内容可用”的非置顶（全是旧内容的专题/cron 会话）；
  // 有十天内存活对话的留在列表，用户接着聊
  if (!sess.pinned && !recentCts.length)
    db.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);
  const points = (body.match(/^[-*]|^\d+\./gm) ?? []).length;
  return { file, points, archived: !sess.pinned && !recentCts.length, archivedN };
}

/** 换届搬运步骤（导出供测试）：cutoff 前的非 system 消息（含历史摘要/旧知识卡）
 * 移入归档表，之后的原位保留；失败只警告不阻断（知识文件已写成，宁多保留上下文不可丢数据） */
export function archiveOlderThan(sessionId: string, cutoff: number, db = getDatabase()): number {
  try {
    const rows = db
      .prepare(
        `SELECT id, role, content, metadata, created_at FROM messages WHERE session_id = ?
         AND (
           (created_at < ? AND (role != 'system' OR content LIKE '%[对话摘要]%'))
           OR content LIKE '【知识要点】%'  -- 旧卡无条件让位：蒸馏必产新卡，重复卡片会堆叠（11-12 修）
         )`,
      )
      .all(sessionId, cutoff) as any[];
    if (!rows.length) return 0;
    const ts0 = Date.now();
    const ins = db.prepare(
      `INSERT OR REPLACE INTO messages_archive (id, session_id, role, content, metadata, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const del = db.prepare("DELETE FROM messages WHERE id = ?");
    db.transaction(() => {
      for (const m of rows) {
        ins.run(m.id, sessionId, m.role, m.content, m.metadata ?? "{}", m.created_at, ts0);
        del.run(m.id);
      }
    })();
    return rows.length;
  } catch (e: any) {
    console.warn("首页换届消息归档失败（知识文件已成，不强求）:", String(e?.message).slice(0, 120));
    return 0;
  }
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
       WHERE status='active'
         AND (distilled_at IS NULL OR (pinned = 1 AND updated_at > COALESCE(distilled_at, 0)))
         AND (distill_skip_at IS NULL OR distill_skip_at < ?)
         AND id NOT IN (SELECT child_session_id FROM sub_agent_runs WHERE status='running')
         AND (
           updated_at < ?
           OR (title LIKE '[cron]%' AND
               (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) >= ?)
         )
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(Date.now() - 3 * 86400000, cutoff, cronMessages, max) as Array<{ id: string; agent_id: string; pinned: number }>;
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
      const res = await distillSession(llm, sessions, r.id, ws, opts.defaultModel, opts.idleDays);
      log(`🧪 蒸馏完成: ${r.agent_id}/${r.id} → ${path.basename(res.file)}（${res.points} 条知识点）`);
      done++;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // 分流（2026-11-12）：真·无价值 → 永久跳过 + 非置顶直接归档隐藏
      //（elf：十天前的零散会话就该从列表消失——薄内容没知识可提炼，但同样该让位）；
      // 空返回/调用失败等 transient → 3 天重试冷却，绝不误标 distilled_at（那=已处理=永久隐藏误伤）
      if (/太少|没有 \d+ 天前的可蒸馏/.test(msg)) {
        getDatabase()
          .prepare("UPDATE sessions SET distilled_at = ?, status = CASE WHEN pinned=1 THEN status ELSE 'archived' END WHERE id = ?")
          .run(Date.now(), r.id);
      } else if (/过短|失败/.test(msg))
        getDatabase().prepare("UPDATE sessions SET distill_skip_at = ? WHERE id = ?").run(Date.now(), r.id);
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
