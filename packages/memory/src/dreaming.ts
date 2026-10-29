import { Database } from "bun:sqlite";
import type { ShortTermMemory } from "./short-term.js";

const DAY_MS = 86400000;

const PROMOTION = { minRecallCount: 3, minUniqueQueries: 2, minScore: 0.5 };

/** ── Dreaming 参数包（2026-10-27 分层改造）─────────────────────────────
 * 原则：时间只用于排序，不用于判死。
 * L0 短期池（软休眠，可复活）→ L1 MEMORY.md（常驻注入，预算 20k）
 * → L2 主题档案 memory/topics/*.md（永久层，随 memoryDir 自动进检索索引）。
 * L1 超预算走三级瀑布：蒸馏成要点 → 迁 L2 → L2 超限季度合并；不删除内容。
 * 覆盖优先级：EASY_AGENT_DREAM_* env > easy-agent.json 的 dreaming 节 > 默认。 */
export interface DreamingConfig {
  /** recency 指数衰减半衰期（天）。原 14 → 30：稀疏使用节奏下别再速死 */
  halfLifeDays: number;
  /** 间隔重复档位（天）。原 [1,2,4,8] → 艾宾浩斯式 5 档，毕业≈62 天 */
  reviewIntervals: number[];
  reviewQueueMax: number;
  /** REM 主题"再现即积累"窗口（天）。原 7 → 21 */
  themeWindowDays: number;
  /** 休眠观察期（天）；0 = 永不按年龄休眠 */
  forgetDays: number;
  /** 休眠附加门槛：score ≥ 此值免休眠（长尾按分数淘汰，不一刀切日期） */
  dormancyScoreFloor: number;
  /** 轻眠每轮最多扫描消息数。原 300 → 800 */
  lightMaxMsgs: number;
  /** L1（MEMORY.md）预算字符数。原 10000 → 20000 */
  memoryBudgetChars: number;
  /** 迁 L2 的段落若年龄超此天数 → 先蒸馏要点再迁（新段原文迁） */
  distillAgeDays: number;
  /** 蒸馏开关（LLM 故障自动回退原文迁移，不丢内容） */
  distillEnabled: boolean;
  /** 单个 L2 档案超此长度 → LLM 季度合并成大事记（≤12 行） */
  l2MergeThresholdChars: number;
}

export const DEFAULT_DREAMING_CONFIG: DreamingConfig = {
  halfLifeDays: 30,
  reviewIntervals: [1, 3, 7, 16, 35],
  reviewQueueMax: 120,
  themeWindowDays: 21,
  forgetDays: 90,
  dormancyScoreFloor: 0.3,
  lightMaxMsgs: 800,
  memoryBudgetChars: 20000,
  distillAgeDays: 21,
  distillEnabled: true,
  l2MergeThresholdChars: 40000,
};

/** 合并配置：文件覆盖 → env 覆盖（env 数值非法时静默忽略该条） */
export function loadDreamingConfig(
  raw?: Partial<DreamingConfig> | null,
): DreamingConfig {
  const cfg: DreamingConfig = { ...DEFAULT_DREAMING_CONFIG, ...(raw ?? {}) };
  const envNum = (name: string): number | undefined => {
    const v = process.env[name];
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const set = (name: keyof DreamingConfig, env: string) => {
    const v = envNum(env);
    if (v !== undefined) cfg[name] = v as never;
  };
  set("halfLifeDays", "EASY_AGENT_DREAM_HALF_LIFE_DAYS");
  set("themeWindowDays", "EASY_AGENT_DREAM_THEME_WINDOW_DAYS");
  set("forgetDays", "EASY_AGENT_DREAM_FORGET_DAYS");
  set("dormancyScoreFloor", "EASY_AGENT_DREAM_DORMANCY_SCORE_FLOOR");
  set("lightMaxMsgs", "EASY_AGENT_DREAM_LIGHT_MAX_MSGS");
  set("memoryBudgetChars", "EASY_AGENT_DREAM_BUDGET_CHARS");
  set("distillAgeDays", "EASY_AGENT_DREAM_DISTILL_AGE_DAYS");
  set("l2MergeThresholdChars", "EASY_AGENT_DREAM_L2_MERGE_CHARS");
  const iv = process.env.EASY_AGENT_DREAM_REVIEW_INTERVALS;
  if (iv) {
    const arr = iv
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (arr.length) cfg.reviewIntervals = arr;
  }
  const qm = envNum("EASY_AGENT_DREAM_REVIEW_QUEUE_MAX");
  if (qm !== undefined) cfg.reviewQueueMax = qm;
  const de = process.env.EASY_AGENT_DREAM_DISTILL;
  if (de !== undefined && de.trim() !== "")
    cfg.distillEnabled = !(de === "0" || de.toLowerCase() === "false");
  return cfg;
}

export interface DreamingDeps {
  db: Database;
  shortTerm: ShortTermMemory;
  llmGenerate: (prompt: string) => Promise<string>;
  readMemory: () => Promise<string>;
  writeMemory: (content: string) => Promise<void>;
  /**
   * 密钥掩码函数（必传）：所有送 LLM 的文本先过它。
   * 用依赖注入而非直接 import core 的 maskSecrets 单例：
   * bun 对 workspace 包在测试/源码两种上下文可能解析出双实例，单例状态会分叉导致掩码失效。
   */
  maskSecret: (text: string) => string;
  /** Dreaming 参数；缺省用 DEFAULT_DREAMING_CONFIG（测试可传快进版） */
  dreaming?: DreamingConfig;
  /**
   * L2 主题档案存储（workspace memory/topics/*.md，随 reindex 自动进检索）。
   * 缺省（如单测）→ 预算溢出退化为"删除最老段"旧行为。
   */
  topicStore?: {
    read: (name: string) => Promise<string | null>;
    write: (name: string, content: string) => Promise<void>;
  };
}

const cfgOf = (deps: DreamingDeps): DreamingConfig =>
  deps.dreaming ?? DEFAULT_DREAMING_CONFIG;

/** 轻眠提取提示词：只提值得长记的事，[重要] 前缀的条目直接进晋升候选。
 * 示例用无关微型对话隔离，防小模型把示例文本拄袭进真实输出 */
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
  const cfg = cfgOf(deps);
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
    .all(cursor, opts.maxMsgs ?? cfg.lightMaxMsgs) as any[];
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
    // 脱敏：送给 LLM 前再掩一次（落库主路径已掩，防旧数据/旁路写入）
    snippets.push(`[${m.role}] ${deps.maskSecret(text).slice(0, 400)}`);
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
    // [重要] 前缀保留入库：deep 逐条保真 + L1 降级时 pinned 保护都靠它识别
    if (important) deps.shortTerm.addImportant(`[重要] ${fact}`, origin);
    else deps.shortTerm.add(fact, origin);
    extracted++;
  }

  persist(maxRid, msgs.length, extracted);
  return { processed: msgs.length, extracted };
}

interface ReviewEntry { step: number; due: number }

/**
 * spaced-reinforcement：被检索命中过但未达晋升门槛的条目 → 排入复习队列
 * （档位来自 cfg.reviewIntervals，默认 1/3/7/16/35 天五级）；
 * 到期复习 = 合成 recall+1 并记 recall_days（拉开召回日期分布 → 抬 calcScore）→ 自然进晋升通道。
 * 零 LLM 成本，纯 DB 操作。
 */
function manageSpacedReviews(
  deps: DreamingDeps,
  now: number,
): { reviews: Record<string, ReviewEntry>; graduated: string[] } {
  const cfg = cfgOf(deps);
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
    if (!activeIds.has(id)) delete reviews[id]; // 已晋升/已休眠 → 退队
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
    if (rv.step >= cfg.reviewIntervals.length - 1) {
      delete reviews[id]; // 训练毕业：不再重入队（防死循环刷题）
      if (!graduated.includes(id)) graduated.push(id);
    } else {
      rv.step++;
      rv.due = now + cfg.reviewIntervals[rv.step]! * DAY_MS;
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
    if (Object.keys(reviews).length >= cfg.reviewQueueMax) break;
    reviews[e.id] = { step: 0, due: now + cfg.reviewIntervals[0]! * DAY_MS };
  }
  return { reviews, graduated };
}

/**
 * REM：三道工序
 * 1) 间隔重复强化（零 LLM：到期复习合成 recall，拉开召回日期分布抬评分）
 * 2) 晋升候选筛选
 * 3) 主题反思：LLM 跨条目归纳反复出现的主题；相关条目记强化信号；
 *    同一主题 cfg.themeWindowDays（默认 21 天）内重复出现 → 作为重要条目进晋升通道。
 */
export async function remDreaming(
  deps: DreamingDeps,
): Promise<{ candidates: number; themes: string[] }> {
  const cfg = cfgOf(deps);
  const now = Date.now();
  const { reviews, graduated } = manageSpacedReviews(deps, now);
  const entries = deps.shortTerm.getActive(); // 复习 bump 后重取，评分含新间隔信号
  const scored = entries.map((e) => ({
    ...e,
    score: calcScore(e, now, cfg.halfLifeDays),
  }));
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
      const list = entries.slice(0, 60).map((e) => `- ${deps.maskSecret(e.text)}`).join("\n");
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

        // 重复主题（窗口内再现）→ 重要条目进晋升；首次 → 只存短期观察
        const prior = history.find(
          (h) => h.name === name && now - h.last < cfg.themeWindowDays * DAY_MS,
        );
        if (prior) {
          prior.count++; prior.last = now;
          const text = `[重要] 主题积累（第${prior.count}次）：${name} — ${conclusion}`;
          const origin = `rem:theme:${name}`;
          // 同一主题只允许一行参与晋升（2026-10-29 修）：旧实现每次再现都
          // addImportant 插新行 → 预热即达标 → 天天重复晋升同一条结论，且 [重要]
          // pinned 永不迁出 → MEMORY.md 被同一事实灌满。现在：
          //   已晋升（L1 已有结论）→ 不再积累；未晋升旧行 → 原地更新计数+预热
          const existing = deps.db
            .prepare(
              `SELECT id, promoted_at FROM short_term_memory
               WHERE origin = ? ORDER BY created_at DESC LIMIT 1`,
            )
            .get(origin) as any;
          if (existing?.promoted_at) {
            // 主题结论已沉淀进 MEMORY.md，后续再现只刷新历史计数，不再入库
          } else if (existing) {
            const today2 = new Date().toISOString().slice(0, 10);
            deps.db
              .prepare(
                `UPDATE short_term_memory SET text = ?, recall_count = 3,
                   unique_queries = 2, recall_days = ?, last_recalled_at = ?
                 WHERE id = ?`,
              )
              .run(text, JSON.stringify([today2]), now, existing.id);
          } else {
            deps.shortTerm.addImportant(text, origin);
          }
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

/** 蒸馏提示词：一行→一行，条数严格一致（数量不符即整体回退原文，防错位） */
const DISTILL_PROMPT = `把每条记忆压缩为一行要点（≤25字）：保留【主体+动作+结论】，含 commit 号/编号等硬信息必须保留，删除背景叙述。
输出每行以 • 开头，条数与输入完全一致，不解释不合并。

格式示例（仅演示格式，切勿拄袭其内容）：
输入：• 10-20 排查 MEMORY.md 为空问题，发现三个根因，其中主因是晋升写入后未删占位行，修复于 commit 6cbffe7
输出：• MEMORY.md 空根因：晋升未删占位行（6cbffe7）

待压缩：
`;

/** 季度合并提示词：L2 档案过长时归纳成大事记 */
const MERGE_PROMPT = `把以下档案内容归纳为不超过 10 行"大事记"：每行以 • 开头（≤40字），合并同类事项，保留日期/commit 号等硬信息。只输出行。\n\n`;

/** 蒸馏一批要点行；LLM 失败/行数不符/单行质量闸门不过 → 该行回退原文（无损） */
async function distillLines(
  deps: DreamingDeps,
  bulletLines: string[],
): Promise<string[]> {
  const raws = bulletLines
    .map((l) => l.replace(/^[•\-*+]\s*/, "").trim())
    .filter(Boolean);
  if (!raws.length) return [];
  try {
    const out = await deps.llmGenerate(
      DISTILL_PROMPT + raws.map((r) => `• ${deps.maskSecret(r)}`).join("\n"),
    );
    const got = out
      .split("\n")
      .map((s) => s.trim().replace(/^[•\-*+\d.、\s]+/, "").trim())
      .filter(Boolean);
    if (got.length !== raws.length) return raws; // 数量不匹配不赌对齐
    return raws.map((orig, i) => {
      const d = got[i]!;
      // 质量闸门：过短/过长/含标签碎片 → 保留原文（宁滥勿缺）
      if (d.length >= 6 && d.length <= 40 && !/[<>【】]/.test(d)) return d;
      return orig;
    });
  } catch {
    return raws;
  }
}

/** 把段落要点追加进 L2 季度档案（promoted-YYYYQn.md）；超阈值做大事记合并 */
async function migrateToL2(
  deps: DreamingDeps,
  cfg: DreamingConfig,
  sectionDate: string,
  lines: string[],
  now: number,
): Promise<void> {
  if (!deps.topicStore || !lines.length || !sectionDate) return;
  const d = new Date(`${sectionDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return;
  const name = `promoted-${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}.md`;
  const today = new Date(now).toISOString().slice(0, 10);
  const cur =
    (await deps.topicStore.read(name)) ??
    `# L2 主题档案 ${name}\n\n由长期记忆（L1）降级而来的要点；可按 origin 回查短期池原文。\n`;
  let next =
    cur +
    `\n## 迁移 (${sectionDate})\n\n` +
    lines.map((l) => `• ${l}`).join("\n") +
    "\n";
  if (next.length > cfg.l2MergeThresholdChars) {
    try {
      const out = await deps.llmGenerate(MERGE_PROMPT + next);
      const got = out
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("•"));
      if (
        got.length >= 1 &&
        got.length <= 12 &&
        got.every((g) => g.length <= 60 && !/[<>]/.test(g))
      ) {
        next = `# L2 主题档案 ${name}（${today} 合并，含 ${sectionDate} 新迁）\n\n${got.join("\n")}\n`;
      }
    } catch {
      // 合并不成也继续追加：档案变大但不丢内容
    }
  }
  await deps.topicStore.write(name, next);
}

/**
 * L1 预算三级瀑布：最老 Promoted 段优先降级；[重要] 行是 pinned 永不迁出；
 * 老化段（> distillAgeDays）先蒸馏成要点再迁 L2，新段原文迁。
 * 无 topicStore（单测环境）→ 退化为旧"删除最老段"。极端仍超支 → 截断兕底。
 */
async function applyBudget(
  deps: DreamingDeps,
  content: string,
  now: number,
): Promise<{ content: string; migrated: number }> {
  const cfg = cfgOf(deps);
  if (content.length <= cfg.memoryBudgetChars)
    return { content, migrated: 0 };

  const dateOf = (s: string) =>
    s.match(/## Promoted \((\d{4}-\d{2}-\d{2})\)/)?.[1] ?? "";
  const parts = content.split(/\n(?=## Promoted \(\d{4}-\d{2}-\d{2})/);
  const head = parts[0] ?? "";
  const rest = parts.slice(1);
  const compose = () =>
    [head, ...rest.filter((s) => s.trim())].join("\n");
  const cutoffDate = new Date(now - cfg.distillAgeDays * DAY_MS)
    .toISOString()
    .slice(0, 10);

  let migrated = 0;
  let guard = 0;
  while (compose().length > cfg.memoryBudgetChars && guard++ < 64) {
    const order = rest
      .map((_, i) => i)
      .filter((i) => rest[i]!.trim())
      .sort((a, b) => (dateOf(rest[a]!) < dateOf(rest[b]!) ? -1 : 1));
    let acted = false;
    for (const i of order) {
      const sec = rest[i]!;
      const header = sec.match(/^## Promoted \([^\)]+\)\n?/)?.[0] ?? "";
      const date = dateOf(sec);
      const bodyLines = sec.slice(header.length).split("\n");
      const movable = bodyLines.filter((l) => l.trim() && !l.includes("[重要]"));
      if (!movable.length) continue; // 全 pinned 段：不动
      const pinned = bodyLines.filter((l) => l.trim() && l.includes("[重要]"));
      let out = movable
        .map((l) => l.replace(/^[•\-*+]\s*/, "").trim())
        .filter(Boolean);
      if (
        deps.topicStore &&
        cfg.distillEnabled &&
        date &&
        date <= cutoffDate
      )
        out = await distillLines(deps, movable);
      if (deps.topicStore) await migrateToL2(deps, cfg, date, out, now);
      migrated += movable.length;
      rest[i] = pinned.length
        ? `${header}${pinned.join("\n")}`
        : "";
      acted = true;
      break; // 一段一段处理，重算长度
    }
    if (!acted) break; // 全是 pinned：不再空转
  }

  let result = compose();
  if (result.length > cfg.memoryBudgetChars)
    result = result.slice(0, cfg.memoryBudgetChars - 100) + "\n\n...[older entries removed]";
  return { content: result, migrated };
}

/**
 * 深眠：达标条目晋升 L1（[重要] 条目逐条保真直写，普通条目 LLM 整合）；
 * 写完后走三级瀑布控预算（蒸馏→迁 L2→季度合并），不删除内容。
 */
export async function deepDreaming(
  deps: DreamingDeps,
): Promise<{ promoted: number; forgotten: number; migrated: number }> {
  const cfg = cfgOf(deps);
  const now = Date.now();
  const entries = deps.shortTerm
    .getActive()
    .map((e) => ({ ...e, score: calcScore(e, now, cfg.halfLifeDays) }))
    .filter(
      (e) =>
        e.score >= PROMOTION.minScore &&
        e.recallCount >= PROMOTION.minRecallCount,
    );
  if (entries.length === 0) {
    // 无新晋升也做 L1 老化维护（平静期也能蒸馏降级）
    const current = await deps.readMemory();
    const kept = await applyBudget(deps, current, now);
    if (kept.content !== current) await deps.writeMemory(kept.content);
    return {
      promoted: 0,
      forgotten: executeForget(deps, now),
      migrated: kept.migrated,
    };
  }

  // [重要] = pinned：不经 LLM 整合（会丢细节/丢前缀），原文直写；预算挤压也最后动它们
  const pinnedEntries = entries.filter((e) => e.text.startsWith("[重要]"));
  const normalEntries = entries.filter((e) => !e.text.startsWith("[重要]"));

  const current = await deps.readMemory();
  const today = new Date().toISOString().slice(0, 10);
  // 占位行不清除会让 buildSystemPrompt 的 "No memories yet" 判断误杀整份记忆 → 永远不注入
  const cleaned = current.replace(/_No memories yet\._\n?/g, "").trimEnd();
  // 双重闸：pinned 条目若已逐字在 L1（历史重复晋升/手改回归），只标记不再写入
  const freshPinned = pinnedEntries.filter(
    (e) => !cleaned.includes(deps.maskSecret(e.text)),
  );
  const dupSkipped = pinnedEntries.length - freshPinned.length;
  const parts: string[] = [];
  if (normalEntries.length) {
    const prompt = `将以下记忆整合为简洁的长期记忆段落：\n\n${normalEntries.map((e) => `- ${deps.maskSecret(e.text)}`).join("\n")}`;
    parts.push(deps.maskSecret(await deps.llmGenerate(prompt)));
  }
  if (freshPinned.length)
    parts.push(freshPinned.map((e) => `- ${deps.maskSecret(e.text)}`).join("\n"));
  const section = parts.filter(Boolean).join("\n\n");

  let final = cleaned;
  let migrated = 0;
  if (section.trim()) {
    ({ content: final, migrated } = await applyBudget(
      deps,
      cleaned + `\n\n## Promoted (${today})\n\n${section}`,
      now,
    ));
  } else {
    // 全部重复跳过：不新增空段，但仍老化维护预算
    ({ content: final, migrated } = await applyBudget(deps, cleaned, now));
  }

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
    .run(
      now,
      JSON.stringify({ promoted: entries.length, forgotten, migrated, dupSkipped }),
      now,
    );

  return { promoted: entries.length, forgotten, migrated };
}

function calcScore(entry: any, nowMs: number, halfLifeDays = 14): number {
  const daysSince =
    (nowMs - (entry.lastRecalledAt ?? entry.createdAt)) / DAY_MS;
  const recency = Math.exp((-0.693 * daysSince) / halfLifeDays);
  const recallFreq = Math.min(entry.recallCount / 10, 1);
  const queryDiv = Math.min(entry.uniqueQueries / 5, 1);
  const consol = Math.min((entry.recallDays?.length ?? 0) / 5, 1);
  return recency * 0.3 + recallFreq * 0.3 + queryDiv * 0.2 + consol * 0.2;
}

/**
 * 软休眠：只把"超观察期 + 从未被召回 + 低分"的条目置 dormant_at 标记。
 * 行永不删除；被检索命中时 ShortTermMemory.incrementRecall 自动复活。
 * forgetDays=0 → 完全关闭按龄休眠。
 */
function executeForget(deps: DreamingDeps, nowMs: number): number {
  const cfg = cfgOf(deps);
  if (cfg.forgetDays <= 0) return 0;
  const cutoff = nowMs - cfg.forgetDays * DAY_MS;
  const rows = deps.db
    .prepare(
      `SELECT id, text, origin, recall_count AS recallCount,
              unique_queries AS uniqueQueries, recall_days AS recallDays,
              last_recalled_at AS lastRecalledAt, created_at AS createdAt
       FROM short_term_memory
       WHERE promoted_at IS NULL AND forgotten_at IS NULL
         AND dormant_at IS NULL AND created_at < ?`,
    )
    .all(cutoff) as any[];
  const mark = deps.db.prepare(
    "UPDATE short_term_memory SET dormant_at = ? WHERE id = ?",
  );
  let n = 0;
  for (const r of rows) {
    const e = { ...r, recallDays: JSON.parse(r.recallDays || "[]") };
    if (calcScore(e, nowMs, cfg.halfLifeDays) < cfg.dormancyScoreFloor) {
      mark.run(nowMs, r.id);
      n++;
    }
  }
  return n;
}
