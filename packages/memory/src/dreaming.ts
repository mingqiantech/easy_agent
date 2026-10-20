import { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ShortTermMemory } from "./short-term.js";

const DAY_MS = 86400000;

const PROMOTION = { minRecallCount: 3, minUniqueQueries: 2, minScore: 0.5 };

const FORGET = {
  shortTermMaxAgeDays: 30,
  shortTermMinRecall: 0,
};

const MEMORY_BUDGET_CHARS = 10000;

export interface DreamingDeps {
  db: Database;
  shortTerm: ShortTermMemory;
  llmGenerate: (prompt: string) => Promise<string>;
  readMemory: () => Promise<string>;
  writeMemory: (content: string) => Promise<void>;
}

/** 轻眠提取提示词：只提值得长记的事，[重要] 前缀的条目直接进晋升候选。
 * 示例用无关微型对话隔离，防小模型把示例文本拄进真实输出 */
const LIGHT_PROMPT = `从对话片段中提取"值得长期记住的事实"：用户偏好、身份、明确决策、踩过的坑。
只提取 [user] 行说出的信息和 [assistant] 行确认的结论；忽略进度汇报、工具细节、格式说明。
每条是完整句子（10~80字），最多 8 条，以 • 开头；会反复用到的偏好/决策加 [重要] 前缀。
没有可提取内容时只输出：无

格式示例（仅演示格式，切勿拄袭其内容）：
输入：[user] 以后项目缩进都用 tab 不用空格
输出：• [重要] 用户要求项目缩进统一用 tab

对话片段：
`;

/**
 * 浅眠：扫新消息（rowid 游标增量）→ LLM 提取事实 → 写入短期记忆。
 * 这是 Dreaming 闭环的入口：对话→提取→(REM 评分)→深眠晋升 MEMORY.md→下轮 system prompt 注入。
 * LLM 失败时游标不前进，下个周期重试（不丢窗口）。
 */
export async function lightDreaming(
  deps: DreamingDeps,
  opts: { maxMsgs?: number } = {},
): Promise<{ processed: number; extracted: number }> {
  const now = Date.now();
  const persist = (cursor: number, processed: number, extracted: number) =>
    deps.db
      .prepare(
        `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('light', ?, ?, ?)`,
      )
      .run(
        now,
        JSON.stringify({ cursor, processed, extracted }),
        now,
      );

  let cursor = 0;
  try {
    const row = deps.db
      .prepare("SELECT state FROM dreaming_state WHERE phase='light'")
      .get() as any;
    cursor = Number(JSON.parse(row?.state ?? "{}")?.cursor ?? 0);
  } catch {}

  const msgs = deps.db
    .prepare(
      `SELECT rowid AS rid, session_id AS sessionId, role, content FROM messages
       WHERE rowid > ? AND role IN ('user','assistant')
       ORDER BY rowid LIMIT ?`,
    )
    .all(cursor, opts.maxMsgs ?? 300) as any[];
  if (!msgs.length) return { processed: 0, extracted: 0 };
  const maxRid = msgs[msgs.length - 1].rid as number;

  const snippets: string[] = [];
  for (const m of msgs) {
    let text = String(m.content ?? "").trim();
    // assistant 历史可能存的是 {text,toolCalls} JSON，取纯文本
    if (m.role === "assistant") {
      try {
        const p = JSON.parse(text);
        if (p && typeof p === "object") text = String(p.text ?? "").trim();
      } catch {}
    }
    if (!text || text.startsWith("【摘要】") || text.startsWith("【系统恢复】")) continue;
    if (text.length < 12 || text.length > 600) continue;
    snippets.push(`[${m.role}] ${text.slice(0, 400)}`);
  }

  if (!snippets.length) {
    persist(maxRid, msgs.length, 0);
    return { processed: msgs.length, extracted: 0 };
  }

  let extracted = 0;
  const out = await deps.llmGenerate(LIGHT_PROMPT + snippets.join("\n"));
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim().replace(/^[•\-*+\d.、\s]+/, "").trim();
    if (!line || /^无[。.]?$/.test(line)) continue;
    const important = line.startsWith("[重要]");
    const fact = line.replace(/^\[重要\]\s*/, "").trim();
    // 质量闸门：要求完整句子；丢弃 XML 标签碎片、纯标题式短语、拄袭示例的行
    if (fact.length < 10 || fact.length > 200) continue;
    if (/[<>]/.test(fact)) continue;
    if (/^[【\[(（].*[】\])）]$/.test(fact)) continue;
    if (/缩进.{0,12}(tab|空格)|tab.{0,8}缩进/.test(fact)) continue; // 格式示例原文拄袭兕底
    const origin = `light:msg#${maxRid}`;
    if (important) deps.shortTerm.addImportant(fact, origin);
    else deps.shortTerm.add(fact, origin);
    extracted++;
  }

  persist(maxRid, msgs.length, extracted);
  return { processed: msgs.length, extracted };
}

/** 间隔重复复习调度：1/2/4/8 天四级，毕业或封顶后移出队列；队列上限防膨胀 */
const REVIEW_INTERVALS = [1, 2, 4, 8];
const REVIEW_QUEUE_MAX = 60;
interface ReviewEntry { step: number; due: number }

/**
 * spaced-reinforcement（对齐 OpenClaw spaced repetition 层）：
 * 被检索命中过但未达晋升门槛的条目 → 排入 1/2/4/8 天复习队列；
 * 到期复习 = 合成 recall+1 并记 recall_days（拉开召回日期分布 → 抬 calcScore）→ 自然进晋升通道。
 * 零 LLM 成本，纯 DB 操作。
 */
function manageSpacedReviews(
  deps: DreamingDeps,
  now: number,
): { reviews: Record<string, ReviewEntry>; graduated: string[] } {
  let reviews: Record<string, ReviewEntry> = {};
  let graduated: string[] = [];
  try {
    const row = deps.db
      .prepare("SELECT state FROM dreaming_state WHERE phase='rem'")
      .get() as any;
    const parsed = JSON.parse(row?.state ?? "{}");
    reviews = parsed?.reviews ?? {};
    graduated = parsed?.graduated ?? [];
  } catch {}

  const active = deps.shortTerm.getActive();
  const activeIds = new Set(active.map((e) => e.id));
  for (const id of Object.keys(reviews))
    if (!activeIds.has(id)) delete reviews[id]; // 已晋升/已遗忘 → 退队
  graduated = graduated.filter((id) => activeIds.has(id));

  const today = new Date(now).toISOString().slice(0, 10);
  const bump = deps.db.prepare(
    `UPDATE short_term_memory SET
       recall_count = recall_count + 1,
       last_recalled_at = ?,
       recall_days = CASE WHEN recall_days NOT LIKE ? THEN json_insert(recall_days,'$[#]',?) ELSE recall_days END
     WHERE id = ? AND promoted_at IS NULL AND forgotten_at IS NULL`,
  );
  for (const [id, rv] of Object.entries(reviews)) {
    if (rv.due > now) continue;
    bump.run(now, `%${today}%`, today, id);
    if (rv.step >= REVIEW_INTERVALS.length - 1) {
      delete reviews[id]; // 训练毕业：不再重入队（防死循环刷题）
      if (!graduated.includes(id)) graduated.push(id);
    } else {
      rv.step++;
      rv.due = now + REVIEW_INTERVALS[rv.step]! * DAY_MS;
    }
  }

  // 新入队：被检索命中过(recall>=1)但门槛未达且不在队列/已毕业
  for (const e of deps.shortTerm.getActive()) {
    if (reviews[e.id] || graduated.includes(e.id) || e.recallCount < 1) continue;
    if (
      e.recallCount >= PROMOTION.minRecallCount &&
      e.uniqueQueries >= PROMOTION.minUniqueQueries
    )
      continue; // 已达标，等 deep 晋升
    if (Object.keys(reviews).length >= REVIEW_QUEUE_MAX) break;
    reviews[e.id] = { step: 0, due: now + REVIEW_INTERVALS[0]! * DAY_MS };
  }
  return { reviews, graduated };
}

/**
 * REM：三道工序（对齐 OpenClaw light→REM 职责）
 * 1) 间隔重复强化（零 LLM：到期复习合成 recall，拉开召回日期分布抬评分）
 * 2) 晋升候选筛选（原逻辑）
 * 3) 主题反思：LLM 跨条目归纳反复出现的主题；相关条目记强化信号（unique_queries/recall_days），
 *    同一主题 7 天内重复出现 → 作为重要条目进晋升通道；首次只见 short-term 不写 MEMORY.md。
 */
export async function remDreaming(
  deps: DreamingDeps,
): Promise<{ candidates: number; themes: string[] }> {
  const now = Date.now();
  const { reviews, graduated } = manageSpacedReviews(deps, now);
  const entries = deps.shortTerm.getActive(); // 复习 bump 后重取，评分含新间隔信号
  const scored = entries.map((e) => ({ ...e, score: calcScore(e, now) }));
  const candidates = scored.filter(
    (e) =>
      e.score >= PROMOTION.minScore &&
      e.recallCount >= PROMOTION.minRecallCount &&
      e.uniqueQueries >= PROMOTION.minUniqueQueries,
  );

  // ── 主题反思 ──
  const themes: string[] = [];
  if (entries.length >= 4) {
    let history: Array<{ name: string; first: number; last: number; count: number }> = [];
    try {
      const row = deps.db
        .prepare("SELECT state FROM dreaming_state WHERE phase='rem'")
        .get() as any;
      history = JSON.parse(row?.state ?? "{}")?.themes ?? [];
    } catch {}

    try {
      const list = entries.slice(0, 60).map((e) => `- ${e.text}`).join("\n");
      const out = await deps.llmGenerate(
        `归纳以下记忆条目中反复出现的主题（最多 3 个）。\n输出每行格式：主题名|一句话结论\n只输出主题行，没有明显主题时只输出：无\n\n${list}`,
      );
      const today = new Date().toISOString().slice(0, 10);
      for (const raw of out.split("\n")) {
        const line = raw.trim().replace(/^[•\-*+\d.、\s]+/, "").trim();
        if (!line || line === "无" || !line.includes("|")) continue;
        const [nameRaw, conclusionRaw] = line.split("|", 2);
        const name = (nameRaw ?? "").trim().replace(/^【|】$/g, "").slice(0, 24);
        const conclusion = (conclusionRaw ?? "").trim().slice(0, 120);
        if (!name || !conclusion) continue;
        themes.push(name);

        // 强化信号：提及该主题的活跃条目 unique_queries+1（晋升评分里的多样性因子）
        const nt = new Set(tokenize(name));
        const boost = deps.db.prepare(
          `UPDATE short_term_memory SET
             unique_queries = unique_queries + 1,
             recall_days = CASE WHEN recall_days NOT LIKE ? THEN json_insert(recall_days,'$[#]',?) ELSE recall_days END
           WHERE id = ?`,
        );
        for (const e of entries) {
          const et = tokenize(e.text.toLowerCase());
          const overlap = et.filter((t) => nt.has(t)).length;
          if (overlap >= 2) boost.run(`%${today}%`, today, e.id);
        }

        // 重复主题（7 天内再现）→ 重要条目进晋升；首次 → 只存短期观察
        const prior = history.find((h) => h.name === name && now - h.last < 7 * DAY_MS);
        if (prior) {
          prior.count++; prior.last = now;
          deps.shortTerm.addImportant(`主题积累（第${prior.count}次）：${name} — ${conclusion}`, `rem:theme:${name}`);
        } else {
          history.push({ name, first: now, last: now, count: 1 });
          deps.shortTerm.add(`主题：${name} — ${conclusion}`, `rem:theme:${name}`);
        }
      }
    } catch {
      // LLM 失败不影响候选统计
    }
    history = history.slice(-24); // 主题历史有界
    deps.db
      .prepare(
        `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('rem', ?, ?, ?)`,
      )
      .run(
        now,
        JSON.stringify({
          candidateCount: candidates.length,
          themes: history,
          reviews,
          graduated,
        }),
        now,
      );
    return { candidates: candidates.length, themes };
  }

  deps.db
    .prepare(
      `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('rem', ?, ?, ?)`,
    )
    .run(
      now,
      JSON.stringify({ candidateCount: candidates.length, reviews, graduated }),
      now,
    );

  return { candidates: candidates.length, themes };
}

/** 本地轻量切词（避免 memory→core 依赖方向问题）：拉丁词 + CJK 相邻二字 */
function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const w of s.split(/[^\p{L}\p{N}_-]+/u)) if (w.length > 1 && !/[\u4e00-\u9fff]/.test(w)) out.push(w);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? [])
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  return out;
}

export async function deepDreaming(
  deps: DreamingDeps,
): Promise<{ promoted: number; forgotten: number }> {
  const now = Date.now();
  const entries = deps.shortTerm
    .getActive()
    .map((e) => ({ ...e, score: calcScore(e, now) }))
    .filter(
      (e) =>
        e.score >= PROMOTION.minScore &&
        e.recallCount >= PROMOTION.minRecallCount,
    );
  if (entries.length === 0) {
    return { promoted: 0, forgotten: executeForget(deps, now) };
  }

  const prompt = `将以下记忆整合为简洁的长期记忆段落：\n\n${entries.map((e) => `- ${e.text}`).join("\n")}`;
  const section = await deps.llmGenerate(prompt);
  const current = await deps.readMemory();
  const today = new Date().toISOString().slice(0, 10);
  // 占位行不清除会让 buildSystemPrompt 的 "No memories yet" 判断误杀整份记忆 → 永远不注入
  const cleaned = current.replace(/_No memories yet\._\n?/g, "").trimEnd();
  const final = enforceBudget(
    cleaned + `\n\n## Promoted (${today})\n\n${section}`,
    MEMORY_BUDGET_CHARS,
  );

  await deps.writeMemory(final);

  const update = deps.db.prepare(
    "UPDATE short_term_memory SET promoted_at = ? WHERE id = ?",
  );
  for (const e of entries) update.run(now, e.id);

  const forgotten = executeForget(deps, now);
  deps.db
    .prepare(
      `INSERT OR REPLACE INTO dreaming_state (phase, last_run_at, state, updated_at) VALUES ('deep', ?, ?, ?)`,
    )
    .run(now, JSON.stringify({ promoted: entries.length, forgotten }), now);

  return { promoted: entries.length, forgotten };
}

function calcScore(entry: any, nowMs: number): number {
  const daysSince =
    (nowMs - (entry.lastRecalledAt ?? entry.createdAt)) / DAY_MS;
  const recency = Math.exp((-0.693 * daysSince) / 14);
  const recallFreq = Math.min(entry.recallCount / 10, 1);
  const queryDiv = Math.min(entry.uniqueQueries / 5, 1);
  const consol = Math.min((entry.recallDays?.length ?? 0) / 5, 1);
  return recency * 0.3 + recallFreq * 0.3 + queryDiv * 0.2 + consol * 0.2;
}

function executeForget(deps: DreamingDeps, nowMs: number): number {
  const cutoff = nowMs - FORGET.shortTermMaxAgeDays * DAY_MS;
  const r = deps.db
    .prepare(
      `
    UPDATE short_term_memory SET forgotten_at = ?
    WHERE promoted_at IS NULL AND forgotten_at IS NULL
      AND created_at < ? AND recall_count <= ?
  `,
    )
    .run(nowMs, cutoff, FORGET.shortTermMinRecall);
  return r.changes;
}

function enforceBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split("\n");
  // 删除最老的 Promoted 段落
  let result = content;
  while (result.length > maxChars) {
    const match = result.match(/## Promoted \(([^)]+)\)/);
    if (!match) break;
    const idx = result.indexOf(match[0]);
    const nextSection = result.indexOf("\n## ", idx + 1);
    if (nextSection === -1) {
      result = result.slice(0, idx).trim();
    } else {
      result = result.slice(0, idx) + result.slice(nextSection);
    }
  }
  if (result.length > maxChars)
    result = result.slice(0, maxChars - 100) + "\n\n...[older entries removed]";
  return result;
}
