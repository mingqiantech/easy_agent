import { Hono } from "hono";
import { PermissionManager, defaultRules } from "@easy-agent/core/permission/index";
import { SkillManager } from "@easy-agent/core/skill/manager";
import { resolveRef } from "@easy-agent/config/models";
import { stripJsonComments } from "@easy-agent/config/loader";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { LLMClient } from "@easy-agent/llm/client";
import type { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import type { MemorySearcher } from "@easy-agent/memory/search";
import type { BasicMemory } from "@easy-agent/core/memory/basic";
import type { BackupManager } from "@easy-agent/core/backup/index";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { Observability } from "@easy-agent/core/observability";
import { getDatabase } from "@easy-agent/core/database";
import { loadSettings, saveSettings } from "./settings.js";
import type { CronManager } from "@easy-agent/core/cron/index";
import { listRuns, runningCount } from "@easy-agent/core/agent/runs";
import { subscribeEvents, emitEvents } from "./bus.js";
import { maskSecrets } from "@easy-agent/core/secrets-mask";
import {
  saveImageUploads,
  resolveUploadFile,
  ocrImage,
  offloadLongText,
  uploadsDir,
} from "./uploads.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * 静态资源目录解析：
 * 源码运行走 import.meta.dir；编译成单文件后该路径不存在，
 * 回退到 ~/.easy-agent/public（install.sh --server 会拷入）。
 */
export function resolvePublicDir(): string {
  const candidates = [
    process.env.EASY_AGENT_PUBLIC_DIR,
    path.join(import.meta.dir, "../public"),
    path.join(
      process.env.EASY_AGENT_STATE_DIR ?? path.join(os.homedir(), ".easy-agent"),
      "public",
    ),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, "index.html"))) return dir;
    } catch {
      // 路径无效，继续下一个
    }
  }
  return candidates[1] ?? candidates[0];
}

export interface AgentRuntime {
  name: string;
  model: string;
  description: string;
  workspaceDir: string;
  thinking: string;
  memory: BasicMemory;
  /** 关联 agent：memory_search 二次索引其工作区（PATCH 可改+持久化） */
  relatedAgents?: string[];
}

export interface ServerDeps {
  llm: LLMClient;
  sessions: SessionManager;
  tools: ToolRegistry;
  searcher: MemorySearcher;
  memory: BasicMemory;
  /** 多工作区隔离：按工作区目录取检索资源（index.ts 注入） */
  resourcesFor?: (wsDir: string) => { searcher: MemorySearcher };
  config: any;
  /** 多 Agent：name -> 运行时（模型/工作区/记忆） */
  agents: Record<string, AgentRuntime>;
  /** 梦境单轮执行器（index.ts 注入：接线 + 防并发） */
  runDreaming?: () => Promise<Record<string, unknown>>;
  /** 强制重建记忆/会话语料索引（知识拓扑立即刷新用；index.ts 注入闭包） */
  reindex?: () => Promise<{ files: number; chunks: number }>;
  /** 备份管理器（设置页备份卡片 + 定时调度共用） */
  backup?: BackupManager;
  /** 检索管道状态（检索拓扑图数据源；index.ts 注入，每次请求现取） */
  getRetrievalStats?: () => Record<string, unknown>;
  /** 嵌入提供方（知识拓扑图相似度计算；index.ts 注入） */
  embedding?: { embed: (text: string) => Promise<Float32Array> };
  /** cron/事件 watcher 管理器 */
  cron?: CronManager;
}

const BUILD_VER = process.env.EASY_AGENT_BUILD ?? String(Date.now());

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  /** 成本护栏 alert 去重（当日一次）+ 审批规则引擎（2026-11-10） */
  let budgetAlerted = "";
  const permMgr = new PermissionManager(defaultRules);
  app.use("*", cors());
  app.use("*", logger());

  // 访问令牌鉴权（2026-11-10 elf 点单）：网关监听全网卡，局域网共享必须配 token。
  // 范围：/api/* 与 /uploads/*；/static、/、/health 公开（登录前 UI 要能加载）。
  // 凭证：Authorization: Bearer <token>（fetch 包装注入）或 cookie ea_token=<token>
  //（服务端认证成功后种下 → <img>/<audio> 子请求自动携带）。
  // env EASY_AGENT_TOKEN 优先于配置（密钥不落 json 的用法）。
  const gwToken = () =>
    process.env.EASY_AGENT_TOKEN || deps.config?.gateway?.token || "";
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (!(p.startsWith("/api/") || p.startsWith("/uploads/"))) return next();
    const tok = gwToken();
    if (!tok) return next();
    const hdr = c.req.header("authorization") ?? "";
    const cookie = (c.req.header("cookie") ?? "").match(/(?:^|;\s*)ea_token=([^;]+)/)?.[1];
    if (hdr !== `Bearer ${tok}` && cookie !== tok)
      return c.json({ error: "unauthorized：缺少或错误的访问令牌", code: "UNAUTHORIZED" }, 401);
    await next();
    // Bearer 验证通过 → 种 cookie，后续媒体子请求（<img src=/uploads>）免提示
    if (hdr === `Bearer ${tok}` && cookie !== tok)
      c.res.headers.append("Set-Cookie", `ea_token=${tok}; Path=/; SameSite=Lax`);
  });

  // UI 单文件迭代快，no-cache 避免改动被浏览器强缓存吞掉（仍支持 ETag/304 协商缓存）
  app.use("/static/*", async (c, next) => {
    c.header("Cache-Control", "no-cache");
    await next();
  });
  app.use(
    "/static/*",
    serveStatic({
      root: resolvePublicDir(),
      rewriteRequestPath: (p) => p.replace(/^\/static/, ""),
    }),
  );
  app.get("/", (c) => c.redirect("/static/index.html?v=" + BUILD_VER));

  const observability = new Observability();
  app.get("/health", (c) => c.json(observability.getHealthCheck()));

  // 多 Agent 列表（供前端切换器）
  app.get("/api/agents", (c) =>
    c.json({
      agents: Object.values(deps.agents).map((a) => ({
        name: a.name,
        model: a.model,
        description: a.description,
        thinking: a.thinking,
        toolsDisable: (a as any).toolsDisable ?? [],
        toolHint: (a as any).extraPrompt, // @deprecated 旧字段名，同值兼容一个周期
        extraPrompt: (a as any).extraPrompt,
        relatedAgents: (a as any).relatedAgents ?? [],
        watchAgents: (a as any).watchAgents ?? [],
      })),
    }),
  );

  // 首页会话：每个 agent 自动获得一个置顶、不可删除的固定会话
  async function ensureHomeSession(agentName: string): Promise<void> {
    const rt = deps.agents[agentName];
    if (!rt) return;
    if (deps.sessions.hasPinned(agentName)) return;
    const systemPrompt = await rt.memory.buildSystemPrompt();
    deps.sessions.create({
      agentId: agentName,
      model: rt.model,
      pinned: true,
      title: "首页",
      systemPrompt,
    });
  }

  app.get("/api/sessions", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const agent = c.req.query("agent") || undefined;
    if (agent) await ensureHomeSession(agent);
    return c.json({ sessions: deps.sessions.list(limit, agent) });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json();
    const agent = deps.agents[body.agentId ?? "default"] ?? deps.agents["default"];
    if (!agent) return c.json({ error: "no agents configured" }, 500);
    const systemPrompt = await agent.memory.buildSystemPrompt();
    const rawModel = body.model ?? agent.model;
    const session = deps.sessions.create({
      agentId: agent.name,
      // alias（如 "local"/"flash"）解析为 canonical provider/model ref
      model: rawModel ? resolveRef(deps.config, rawModel) : undefined,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 60) : undefined,
      systemPrompt,
    });
    return c.json({ session }, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const s = deps.sessions.get(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    return c.json({ session: s });
  });

  // 会话内切换模型 / 重命名
  app.patch("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const s = deps.sessions.get(id);
    if (!s) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    if (typeof body.model === "string" && body.model) deps.sessions.setModel(id, body.model);
    if (typeof body.title === "string") deps.sessions.setTitle(id, body.title);
    return c.json({ session: deps.sessions.get(id) });
  });

  // 可选模型列表（配置目录 + 主链），供对话框切换器
  app.get("/api/models", (c) => {
    const catalog: Record<string, { alias?: string }> = deps.config.models ?? {};
    let models = Object.entries(catalog).map(([ref, e]) => ({
      ref,
      alias: e.alias ?? "",
    }));
    if (models.length === 0) models = [{ ref: deps.config.defaultModel, alias: "" }];
    return c.json({ models });
  });

  // 消息总结：把当前会话提炼成一条摘要写回历史（带【摘要】标记）
  app.post("/api/sessions/:id/summarize", async (c) => {
    const id = c.req.param("id");
    const session = deps.sessions.get(id);
    if (!session) return c.json({ error: "not found" }, 404);

    const conv = deps.sessions
      .getMessages(id)
      .filter(
        (m: any) =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          !m.content.startsWith("【摘要】"),
      );
    if (conv.length < 2) return c.json({ error: "消息太少，无需总结" }, 400);

    const transcript = conv
      .slice(-60)
      .map((m: any) => `${m.role === "user" ? "用户" : "AI"}: ${String(m.content).slice(0, 500)}`)
      .join("\n")
      .slice(0, 12000);

    const res = await deps.llm.generate({
      model: session.model,
      system: "你是会话摘要助手。用简洁中文提炼对话的要点、决定与待办，不超过 200 字。",
      messages: [{ role: "user", content: `请总结以下对话：\n${transcript}` }],
      generation: { maxTokens: 400 },
    });

    const summary = (res.content ?? "").trim();
    deps.sessions.addMessage(id, {
      role: "assistant",
      content: `【摘要】${summary}`,
    });
    return c.json({ summary });
  });

  // Agent 拓扑总地图：agent 节点 + 其下挂的最近子代理运行（runs）
  app.get("/api/topology", (c) => {
    const db = getDatabase();
    const nowTs = Date.now();
    // 实时运行台账（轮开始写入/轮末删除）：真·工作状态唯一来源
    const turnMap = new Map<string, any>(
      (db.prepare("SELECT session_id, steps_done, current_tool, started_at, last_step_at FROM active_turns").all() as any[])
        .map((r) => [r.session_id, r]),
    );

    const nodes = Object.values(deps.agents).map((a) => {
      const agg = db
        .prepare(
          `SELECT COUNT(*) c, MAX(updated_at) last FROM sessions
           WHERE agent_id = ? AND status = 'active'`,
        )
        .get(a.name) as any;
      const tasks = db
        .prepare(
          `SELECT s.id, s.title, s.model, s.updated_at,
                  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) msg_count
           FROM sessions s
           WHERE s.agent_id = ? AND s.status = 'active'
           ORDER BY s.updated_at DESC LIMIT 3`,
        )
        .all(a.name) as any[];
      // 历史 tool_calls 表无任何写入方（死表），计数改从 sub_agent_runs 聚合
      const sub = db
        .prepare(
          `SELECT COUNT(*) n FROM sub_agent_runs WHERE parent_agent = ?`,
        )
        .get(a.name) as any;
      const runs = db
        .prepare(
          `SELECT child_session_id, task, model, status, steps, tool_calls,
                  total_tokens, started_at, finished_at,
                  COALESCE(target_agent,
                    (SELECT s.agent_id FROM sessions s WHERE s.id = sub_agent_runs.child_session_id)) AS target_agent
           FROM sub_agent_runs WHERE parent_agent = ?
           ORDER BY started_at DESC LIMIT 4`,
        )
        .all(a.name) as any[];

      // 实际运行模型：以最近活跃会话的 model 为准（会话可单独切换，配置默认会过时）
      const effectiveModel = tasks.find((t: any) => t.model)?.model ?? a.model;
      const runningNow = (tasks ?? []).filter((t: any) => turnMap.has(t.id));
      // 工作主题：本轮最后一条用户消息文本（长文本卸载引用取预览）；脱敏后截断
      const subjectOf = (sessionId: string): string => {
        const m = db
          .prepare(
            `SELECT content FROM messages WHERE session_id = ? AND role = 'user'
             ORDER BY rowid DESC LIMIT 1`,
          )
          .get(sessionId) as any;
        let t = String(m?.content ?? "").trim();
        const lt = /\[长文本已存文件：[^\]]*\]--- 前 400 字预览 ---/.exec(t);
        if (lt) t = t.slice(lt.index + lt[0].length);
        t = t.replace(/\s+/g, " ");
        return maskSecrets(t).slice(0, 48);
      };
      return {
        name: a.name,
        model: effectiveModel,
        configModel: a.model,
        description: a.description,
        thinking: a.thinking,
        sessions: agg?.c ?? 0,
        lastActive: agg?.last ?? 0,
        busy: runningNow.length > 0, // 真·在跑（台账）；此前是"2 分钟内有更新"的猜测
        working: runningNow.map((t: any) => {
          const tr = turnMap.get(t.id);
          return {
            sessionId: t.id,
            title: t.title ?? "untitled",
            subject: subjectOf(t.id),
            step: tr.steps_done,
            tool: tr.current_tool ?? null,
            sinceSec: Math.max(0, Math.round((nowTs - tr.started_at) / 1000)),
          };
        }),
        subAgentCalls: sub?.n ?? 0,
        runs: (runs ?? []).map((r) => ({
          childSessionId: r.child_session_id,
          task: r.task,
          model: r.model,
          status: r.status,
          steps: r.steps,
          toolCalls: r.tool_calls,
          totalTokens: r.total_tokens,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          targetAgent: r.target_agent ?? null,
        })),
        currentTasks: (tasks ?? []).map((t) => ({
          id: t.id,
          title: t.title ?? "untitled",
          model: t.model,
          msgCount: t.msg_count,
          ageSec: Math.max(0, Math.round((nowTs - t.updated_at) / 1000)),
          running: turnMap.has(t.id),
        })),
      };
    });

    // 真实 agent↔agent 连接：从全量 sub_agent_runs 聚合（子会话归属=目标 agent；
    // 泛 sub-agent 池不算）——此前只有一条指向伪节点 "sub-agents" 的边，
    // 跨 agent 互调在拓扑上完整看不见（2026-10-31 elf 反馈）
    const agentNames = new Set(nodes.map((n) => n.name));
    const edgeMap = new Map<string, { from: string; to: string; weight: number; last: number; status: string }>();
    for (const r of db
      .prepare(
        `SELECT parent_agent AS from_agent,
                COALESCE(target_agent,
                  (SELECT s.agent_id FROM sessions s WHERE s.id = sub_agent_runs.child_session_id)) AS to_agent,
                MAX(started_at) last,
                CASE WHEN MAX(CASE WHEN status = 'running' THEN 1 ELSE 0 END) = 1 THEN 'running' ELSE MAX(status) END AS status
         FROM sub_agent_runs
         WHERE parent_agent IS NOT NULL
         GROUP BY parent_agent, child_session_id`,
      )
      .all() as any[]) {
      const { from_agent: from, to_agent: to } = r;
      if (!from || !to || to === 'sub-agent' || !agentNames.has(from) || !agentNames.has(to)) continue;
      const key = `${from}→${to}`;
      const e = edgeMap.get(key) ?? { from, to, weight: 0, last: 0, status: 'ok' };
      e.weight += 1;
      if ((r.last ?? 0) > e.last) e.last = r.last;
      if (r.status === 'running') e.status = 'running';
      else if (e.status !== 'running' && r.status === 'error' && e.status !== 'ok') e.status = 'error';
      edgeMap.set(key, e);
    }
    const edges: Array<{ from: string; to: string; weight: number; last: number; status: string; kind: "call" | "related" | "watch" }> =
      [...edgeMap.values()].map((e) => ({ ...e, kind: "call" as const }));
    // related 边：agent 配了 relatedAgents（memory_search 二查通道）也在图上可视化；
    // "*" 按 resolveRelated 同规则展开。边类型可扩展：将来 watch/监视只需新增 kind，
    // 前端按 kind 配色/线型渲染即可（2026-10-31 elf：拓扑还要能表达监视等关系）
    for (const a of Object.values(deps.agents)) {
      // 监视边：watchAgents 配置（拓扑 kind=watch；"*" 同 relatedAgents 规则展开）
      const watch = ((a as any).watchAgents as string[] | undefined) ?? [];
      const wNames = watch.includes("*")
        ? nodes.map((n) => n.name).filter((n) => n !== a.name)
        : watch;
      for (const to of wNames) {
        if (to === a.name || !agentNames.has(to)) continue;
        if (edges.some((e) => e.from === a.name && e.to === to && e.kind === "call")) continue;
        if (edges.some((e) => e.from === a.name && e.to === to && e.kind === "watch")) continue;
        edges.push({ from: a.name, to, weight: 0, last: 0, status: "watch", kind: "watch" as const });
      }
      const rel = (a as any).relatedAgents as string[] | undefined;
      if (!rel?.length) continue;
      const names = rel.includes("*")
        ? nodes.map((n) => n.name).filter((n) => n !== a.name)
        : rel;
      for (const to of names) {
        if (to === a.name || !agentNames.has(to)) continue;
        // related 与 call 共存时两条都画（分带不重叠：call 上弧/related 下弧）；
        // 此前“实调用边优先”直接跳过，图上误示为无检索通道（2026-10-31 实测发现）
        if (edges.some((e) => e.from === a.name && e.to === to && e.kind === "related")) continue;
        edges.push({ from: a.name, to, weight: 0, last: 0, status: "related", kind: "related" as const });
      }
    }
    // 是否还有派给泛用 sub-agent 池的活（非具名 agent）
    const hasSubAgentPool = (db
      .prepare(
        `SELECT COUNT(*) n FROM sub_agent_runs r
         LEFT JOIN sessions s ON s.id = r.child_session_id
         WHERE COALESCE(r.target_agent, s.agent_id) = 'sub-agent'`,
      )
      .get() as any)?.n > 0;

    return c.json({
      nodes,
      edges,
      hasSubAgentPool: edges.length > 0,
      generatedAt: nowTs,
    });
  });

  app.delete("/api/sessions/:id", (c) => {
    const ok = deps.sessions.delete(c.req.param("id"));
    if (!ok)
      return c.json({ error: "首页会话不可删除" }, 403);
    return c.json({ ok: true });
  });

  /** 用户上传图片的缩略图访问（UI 用）；文件名白名单后缀 + basename 防穿越 */
  app.get("/uploads/:file", (c) => {
    const abs = resolveUploadFile(c.req.param("file"));
    if (!abs) return c.json({ error: "not found" }, 404);
    const ext = abs.split(".").pop()!;
    const mime =
      { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", mp3: "audio/mpeg" }[ext] ??
      "application/octet-stream";
    // svg 可能是 agent 生成的：限制内嵌行为，防脚本执行
    if (ext === "svg")
      return c.body(new Uint8Array(fs.readFileSync(abs)), 200, {
        "Content-Type": mime,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
      });
    return c.body(new Uint8Array(fs.readFileSync(abs)), 200, {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  app.get("/api/sessions/:id/messages", (c) => {
    // 全量历史（含压缩归档）；LLM 上下文仍走 getMessages（仅活跃窗口）
    return c.json({ messages: deps.sessions.getFullMessages(c.req.param("id")) });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const body = await c.req.json();
    const id = c.req.param("id");
    // 图片附件：base64 → uploads 目录落盘，拿文件引用传给 run（存 metadata.images）
    let imageRefs: ReturnType<typeof saveImageUploads>["refs"] = [];
    if (Array.isArray(body.images) && body.images.length) {
      const { refs, errors } = saveImageUploads(body.images);
      if (errors.length && !refs.length)
        return c.json({ error: "图片无效：" + errors.join("；") }, 400);
      imageRefs = refs;
    }
    if (!String(body.text ?? "").trim() && !imageRefs.length)
      return c.json({ error: "消息内容为空" }, 400);
    const sess = deps.sessions.get(id);
    // 非视觉模型：图片 OCR 转文字拼进正文（工作区守则：识别统一走 rapidocr）；
    // 视觉模型直接发 image part。refs 带 ocr 标记后 convert 层不再展开图。
    if (imageRefs.length) {
      const modelRef = sess?.model ?? "";
      const vision = /vl|vision|qvq|omni|minimax|gemini/i.test(modelRef);
      if (!vision) {
        for (const ref of imageRefs) {
          const txt = await ocrImage(path.join(uploadsDir(), ref.file));
          if (txt) {
            ref.ocr = txt;
            body.text = `${String(body.text ?? "").trim()}\n\n【图片 ${ref.name} OCR 识别内容】\n${txt}`.trim();
          }
        }
      }
    }
    // 长文本卸载：超阈值消息先落盘，上下文只留引用+预览（模型用 read 按需取段）；
    // 在 OCR 拼接之后做，图文合并超长也能盖到
    if (typeof body.text === "string" && body.text)
      body.text = offloadLongText(body.text);
    // 成本护栏（2026-11-10）：当日花费超 budget.dailyUsd → block 拒新消息 / alert 每日推一次告警
    {
      const b = deps.config.budget;
      if (b) {
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const row = getDatabase()
          .prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM token_usage WHERE created_at >= ?")
          .get(midnight.getTime()) as any;
        const spent = Number(row?.c ?? 0);
        if (spent >= b.dailyUsd) {
          const msg = `💰 预算护栏：今日已用 $${spent.toFixed(2)} ≥ 限额 $${b.dailyUsd}`;
          if (b.mode === "block")
            return c.json({ error: msg + "（block 模式拒收新消息；可调 budget 或明日再用）" }, 429);
          const todayKey = new Date().toISOString().slice(0, 10);
          if (budgetAlerted !== todayKey && deps.config.wecom?.alertChatId) {
            budgetAlerted = todayKey;
            getDatabase()
              .prepare("INSERT INTO outbox (chat_id, text, created_at) VALUES (?,?,?)")
              .run(deps.config.wecom.alertChatId, msg + "（alert 模式继续运行；如需拦截改 budget.mode=block）", Date.now());
          }
        }
      }
    }
    const agent = sess ? deps.agents[sess.agentId] : undefined;
    // agent 专属工具裁剪：黑名单内工具对模型不可见且拒绝执行
    const dis = new Set<string>((agent as any)?.toolsDisable ?? []);
    // 外部编码工具使用引导：仅在该 agent 真拿得到工具时注入；extraPrompt 叠加在后
    const traeOn = deps.tools.names().includes("trae_agent") && !dis.has("trae_agent");
    const acpOn = deps.tools.names().includes("acp_agent") && !dis.has("acp_agent");
    let extraSystem = "";
    const opts = (traeOn || acpOn)
      ? [
          traeOn && "trae_agent（一次性外包：发任务拿结果）",
          acpOn && "acp_agent（多轮长会话：连续多步/需保持上下文时用，同 workdir 自动复用）",
        ]
          .filter(Boolean)
          .join(" / ")
      : "";
    if ((agent as any)?.extraPrompt) {
      // 自定义策略优先；若工具可用只声明可用性，不再附带“别外包”劝退句（避免指令冲突）
      const lead = opts ? `外部编码 Agent 可用：${opts}。是否外包/何时外包完全由下条自定义策略决定。\n` : "";
      extraSystem = lead + String((agent as any).extraPrompt);
    } else if (opts) {
      extraSystem = `外部编码 Agent 可用：${opts}。当任务涉及多文件代码修改、仓库整体分析、批量重构、写/补测试等重活时，优先用它们处理（workdir 指向目标仓库），完成后汇总结果；日常问答、概念解释、小改动不要外包（每次调用有固定开销）。`;
    }
    // 监视职责引导（2026-10-31）：配了 watchAgents 的 agent 每轮知道自已是监视者
    const watchList = (agent as any)?.watchAgents as string[] | undefined;
    if (watchList?.length) {
      const suffix = `\n监视职责：你负责监视 ${watchList.join(", ")}。需要了解对方时用 agent_status 工具查运行状态（在跑什么/卡在哪步/多久没动静）；发现异常（长时间卡在同一步、连续报错）主动向用户报告，不要无打扰地虚构对方状态。`;
      extraSystem = extraSystem ? extraSystem + suffix : suffix.trimStart();
    }
    // 技能触发词注入（2026-11-10）：本轮用户文本命中该 agent 工作区技能触发词 →
    // SKILL.md 正文直接入本轮 system（不再只靠模型自觉 read）；per-request 不落库
    if (agent && typeof body.text === "string" && body.text.trim()) {
      try {
        const skill = await agent.memory.matchSkill(body.text);
        if (skill) {
          const body8k = skill.instructions.length > 8000 ? skill.instructions.slice(0, 8000) + "\n…（技能正文已截断，完整版用 read 工具读 " + skill.dir + "/SKILL.md）" : skill.instructions;
          const suffix = `\n<skill name="${skill.name}">\n本轮命中技能「${skill.name}」，按以下指引执行：\n${body8k}\n</skill>`;
          extraSystem = extraSystem ? extraSystem + suffix : suffix.trimStart();
          console.log(`🎯 skill 命中: ${agent.name}/${skill.name}`);
        }
      } catch (e: any) {
        console.warn("skill 匹配失败:", String(e?.message).slice(0, 120));
      }
    }
    const baseRegistry = dis.size
      ? {
          getDefinitions: () => deps.tools.getDefinitions().filter((d) => !dis.has(d.name)),
          execute: (name: string, input: unknown, ctx: any) =>
            dis.has(name)
              ? Promise.resolve({ output: null, error: `工具 "${name}" 已被该 agent 配置禁用` })
              : deps.tools.execute(name, input, ctx),
        }
      : deps.tools;
    // 审批门（2026-11-10，config.approvals.enabled 才生效）：PermissionManager ask → 落 approvals 阻塞等待
    // （Web UI/企微批复，10 分钟超时或会话 abort 自动拒）；deny 直接拒；无规则工具放行（不管辖未知工具）
    const toolRegistry = deps.config.approvals?.enabled
      ? {
          getDefinitions: () => baseRegistry.getDefinitions(),
          execute: async (name: string, input: unknown, ctx: any) => {
            const detail =
              (input as any)?.command ??
              (input as any)?.path ??
              JSON.stringify(input ?? {}).slice(0, 300);
            const d = permMgr.check(name, String(detail));
            if (d.permission === "deny" || d.reason === "denylist") {
              if (d.permission === "deny")
                return { output: null, error: `权限规则拒绝（${d.reason}）：${String(detail).slice(0, 120)}` };
            }
            if (d.permission === "allow" || d.reason === "no rule")
              return baseRegistry.execute(name, input, ctx);
            // ask：创建审批并等待
            const dbA = getDatabase();
            const ins = dbA
              .prepare("INSERT INTO approvals (session_id, agent_id, tool_name, detail, reason, created_at) VALUES (?,?,?,?,?,?)")
              .run(ctx.sessionId, ctx.agentId, name, String(detail).slice(0, 500), d.reason, Date.now());
            const approvalId = Number(ins.lastInsertRowid);
            bus({ type: "approval_required", approvalId, toolName: name, detail: String(detail).slice(0, 160) });
            const deadline = Date.now() + 10 * 60_000;
            for (;;) {
              await new Promise((r) => setTimeout(r, 1500));
              if (ctx.abortSignal?.aborted) {
                dbA.prepare("UPDATE approvals SET status='denied', resolved_at=? WHERE id=? AND status='pending'").run(Date.now(), approvalId);
                return { output: null, error: "会话已中断，审批作废" };
              }
              const row = dbA.prepare("SELECT status FROM approvals WHERE id=?").get(approvalId) as any;
              if (row?.status === "allowed") return baseRegistry.execute(name, input, ctx);
              if (row?.status === "denied")
                return { output: null, error: `审批被拒：${name} ${String(detail).slice(0, 120)}` };
              if (Date.now() > deadline) {
                dbA.prepare("UPDATE approvals SET status='timeout', resolved_at=? WHERE id=? AND status='pending'").run(Date.now(), approvalId);
                return { output: null, error: "审批超时（10 分钟无人处理），本次操作未执行" };
              }
            }
          },
        }
      : baseRegistry;
    // 排队/转向：会话有任务在跑 → 入队，运行循环会并入当前上下文
    // （带图消息不入队：转向链路只支持纯文本，直接走本轮附带）
    if (
      typeof body.text === "string" &&
      body.text &&
      !imageRefs.length &&
      deps.sessions.queueMessage(id, body.text)
    ) {
      return c.json({ status: "queued" }, 202);
    }
    // 带图消息不支持排队转向：本轮在跑时直接拒绝，避免并发双循环串话
    if (imageRefs.length && deps.sessions.isBusy(id))
      return c.json({ error: "当前轮任务进行中，图片消息请等它结束后再发" }, 409);
    const bus = (e: Record<string, unknown>) =>
      emitEvents(id, { sessionId: id, ts: Date.now(), ...e });
    bus({ type: "run_start" });
    try {
      const response = await deps.sessions.run(id, body.text ?? "", {
        toolRegistry,
        // 工具有效工作目录 = 会话所属 agent 的隔离工作区（memory_search 分发也靠它）
        workDir: agent?.workspaceDir,
        extraSystem: extraSystem || undefined,
        ...(imageRefs.length ? { images: imageRefs } : {}),
        thinking: agent?.thinking as
          | "off"
          | "low"
          | "medium"
          | "high"
          | undefined,
        onEvent: (ev) => {
          if (ev.type === "text" && ev.text)
            bus({ type: "text", text: maskSecrets(ev.text) });
          else if (ev.type === "tool_start")
            bus({ type: "tool_start", name: ev.name });
        },
        onToolResult: (name, result) => {
          const str =
            typeof result === "string" ? result : JSON.stringify(result ?? "");
          bus({
            type: "tool_end",
            name,
            preview: maskSecrets(str).slice(0, 160),
          });
        },
      });
      // 空响应（core 重试后仍空）：占位消息已落库，但 live 气泡需同步提示，避免“没下文”
      if (!String(response ?? "").trim())
        bus({ type: "run_end", error: "模型本轮未返回内容（已重试），请重发或换个说法" });
      else bus({ type: "run_end" });
      return c.json({ response });
    } catch (e: any) {
      bus({ type: "run_end", error: String(e?.message ?? e).slice(0, 200) });
      throw e;
    }
  });

  // Agent 运行时参数修改：即时生效 + 直写 easy-agent.json 的 agents 节
  // （2026-10-31 elf 点单废掉 agents-state.json 双层结构：配置文件单一真相，
  // default 也在这里管理；注意注释会在回写时丢失，密钥建议继续用 ${ENV} 占位）
  app.patch("/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    const agent = deps.agents[name];
    if (!agent) return c.json({ error: `unknown agent: ${name}` }, 404);
    const body = await c.req.json().catch(() => ({}) as any);
    const levels = ["off", "low", "medium", "high"];
    // 可选：agent 专属工具黑名单开关（如关 trae）；数组=替换语义，[]=清空
    const hasToolsDisable = body.toolsDisable !== undefined;
    if (hasToolsDisable && !Array.isArray(body.toolsDisable))
      return c.json({ error: "toolsDisable 必须是字符串数组" }, 400);
    if (hasToolsDisable && body.toolsDisable.some((x: any) => typeof x !== "string"))
      return c.json({ error: "toolsDisable 元素必须是字符串" }, 400);
    // 关联 agent（二次索引对象名单，支持通配符 "*"=全部）：数组=替换语义，自动剔除自身
    const hasRelated = body.relatedAgents !== undefined;
    if (hasRelated && (!Array.isArray(body.relatedAgents) || body.relatedAgents.some((x: any) => typeof x !== "string")))
      return c.json({ error: 'relatedAgents 必须是字符串数组（"*"=全部其他 agent）' }, 400);
    // 监视名单（2026-10-31）：拓扑 watch 边 + agent_status 巡检权限，数组=替换语义
    const hasWatch = body.watchAgents !== undefined;
    // 附加提示词（2026-11-02 改名 toolHint→extraPrompt；body 旧名仍接受，写入落新名）
    const hasExtraPrompt = body.extraPrompt !== undefined || body.toolHint !== undefined;
    const ep = body.extraPrompt !== undefined ? body.extraPrompt : body.toolHint;
    if (hasWatch && (!Array.isArray(body.watchAgents) || body.watchAgents.some((x: any) => typeof x !== "string")))
      return c.json({ error: 'watchAgents 必须是字符串数组（"*"=全部其他 agent）' }, 400);
    if (typeof body.thinking === "string" && body.thinking) {
      if (!levels.includes(body.thinking))
        return c.json({ error: "thinking 必须是 off|low|medium|high" }, 400);
      agent.thinking = body.thinking;
    } else if (!hasToolsDisable && !hasExtraPrompt && !hasRelated && !hasWatch) {
      return c.json({ error: "thinking 必须是字符串" }, 400);
    }
    if (hasToolsDisable) (agent as any).toolsDisable = body.toolsDisable;
    if (hasExtraPrompt && ep !== null && typeof ep !== "string")
      return c.json({ error: "extraPrompt 必须是字符串或 null（清除）" }, 400);
    if (typeof ep === "string" && ep.length > 2000)
      return c.json({ error: "extraPrompt 最长 2000 字符" }, 400);
    if (hasExtraPrompt) (agent as any).extraPrompt = ep ?? undefined;
    if (hasRelated) (agent as any).relatedAgents = (body.relatedAgents as string[]).filter((n) => n !== name);
    if (hasWatch) (agent as any).watchAgents = (body.watchAgents as string[]).filter((n) => n !== name);
    try {
      const file =
        deps.config.configPath ??
        path.join(deps.config.stateDir, "easy-agent.json");
      let data: any = {};
      try {
        data = JSON.parse(stripJsonComments(fs.readFileSync(file, "utf-8")));
      } catch {}
      const cur: any = { ...(data.agents?.[name] ?? {}) };
      if (typeof body.thinking === "string" && body.thinking) cur.thinking = body.thinking;
      if (hasToolsDisable) cur.tools = { ...(cur.tools ?? {}), disable: body.toolsDisable };
      if (hasExtraPrompt) {
        delete cur.toolHint; // 旧键退场，防双写分叉
        if (ep === null) delete cur.extraPrompt;
        else cur.extraPrompt = ep;
      }
      if (hasRelated) cur.relatedAgents = (body.relatedAgents as string[]).filter((n2) => n2 !== name);
      if (hasWatch) cur.watchAgents = (body.watchAgents as string[]).filter((n2) => n2 !== name);
      data.agents = { ...(data.agents ?? {}), [name]: cur };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      // 内存 config 同步：重启前再次 resolveAgents/读配置也用新值
      deps.config.agents = { ...(deps.config.agents ?? {}), [name]: { ...(deps.config.agents?.[name] ?? {}), ...cur } };
    } catch (e: any) {
      return c.json({ error: `运行时已生效但写配置文件失败: ${e.message}` }, 500);
    }
    return c.json({
      agent: {
        name: agent.name,
        model: agent.model,
        description: agent.description,
        thinking: agent.thinking,
      },
    });
  });

  // 记忆资源按 agent 归属（多工作区隔离）；缺省 default 旧共享区
  const memFor = (agent?: string) =>
    (agent && deps.agents[agent]?.memory) || deps.memory;
  const searcherFor = (agent?: string) => {
    const wd = agent ? deps.agents[agent]?.workspaceDir : undefined;
    return (wd && deps.resourcesFor?.(wd).searcher) || deps.searcher;
  };

  app.get("/api/memory/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    return c.json(await searcherFor(c.req.query("agent")).search(q));
  });

  app.get("/api/memory/file", async (c) => {
    const p = c.req.query("path");
    if (!p) return c.json({ error: "missing path" }, 400);
    return c.json(await memFor(c.req.query("agent")).readMemory());
  });

  // ── 设置：梦境调度 + 记忆（Web 设置页） ──
  app.get("/api/settings", (c) => {
    const db2 = getDatabase();
    const rows = db2
      .prepare("SELECT phase, last_run_at, state FROM dreaming_state")
      .all() as any[];
    const status: Record<string, any> = {};
    for (const r of rows) {
      let parsed: any = {};
      try {
        parsed = JSON.parse(r.state || "{}");
      } catch {}
      status[r.phase] = { lastRunAt: r.last_run_at, ...parsed };
    }
    return c.json({
      settings: loadSettings(deps.config.stateDir),
      dreamingStatus: status,
      paths: {
        stateDir: deps.config.stateDir,
        workspaceDir: deps.config.workspaceDir,
      },
    });
  });

  app.patch("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    const cur = loadSettings(deps.config.stateDir);
    const d = body.dreaming ?? {};
    if (typeof d.enabled === "boolean") cur.dreaming.enabled = d.enabled;
    if (typeof d.intervalMinutes === "number") {
      const v = Math.round(d.intervalMinutes);
      if (v < 5 || v > 10080)
        return c.json({ error: "intervalMinutes 需在 5~10080 分钟之间" }, 400);
      cur.dreaming.intervalMinutes = v;
    }
    const b = body.backup ?? {};
    if (typeof b.enabled === "boolean") cur.backup.enabled = b.enabled;
    if (typeof b.intervalHours === "number") {
      const v = Math.round(b.intervalHours);
      if (v < 1 || v > 168)
        return c.json({ error: "intervalHours 需在 1~168 之间" }, 400);
      cur.backup.intervalHours = v;
    }
    if (typeof b.keep === "number") {
      const v = Math.round(b.keep);
      if (v < 1 || v > 50)
        return c.json({ error: "keep 需在 1~50 之间" }, 400);
      cur.backup.keep = v;
    }
    saveSettings(deps.config.stateDir, cur);
    return c.json({ settings: cur });
  });

  app.post("/api/settings/dreaming/run", async (c) => {
    if (!deps.runDreaming) return c.json({ error: "梦境不可用" }, 503);
    try {
      return c.json({ ok: true, result: await deps.runDreaming() });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 500);
    }
  });

  // ── 备份：列表 / 立即备份 / 恢复（设置页备份卡片） ──
  app.get("/api/backup", async (c) => {
    if (!deps.backup) return c.json({ error: "备份不可用" }, 503);
    const st = loadSettings(deps.config.stateDir);
    return c.json({ settings: st.backup, backups: await deps.backup.list() });
  });
  app.post("/api/backup", async (c) => {
    if (!deps.backup) return c.json({ error: "备份不可用" }, 503);
    const st = loadSettings(deps.config.stateDir);
    try {
      return c.json({ ok: true, backup: await deps.backup.backup({ keep: st.backup.keep }) });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 500);
    }
  });
  app.post("/api/backup/restore", async (c) => {
    if (!deps.backup) return c.json({ error: "备份不可用" }, 503);
    const body = await c.req.json().catch(() => ({}) as any);
    const name = String(body.name ?? "");
    // 只接受备份目录内的文件名，防路径穿越
    if (!name || name.includes("/") || name.includes("..") || !name.startsWith("backup-"))
      return c.json({ error: "非法备份名" }, 400);
    const p = path.join(deps.backup.dir, name);
    if (!fs.existsSync(p)) return c.json({ error: "备份不存在" }, 404);
    try {
      await deps.backup.restore(p);
      return c.json({ ok: true, restartNeeded: true });
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 500);
    }
  });

  // ── 全文搜索：跨会话搜消息（含压缩归档） ──
  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "missing q" }, 400);
    if (q.length > 200) return c.json({ error: "q 过长（≤200 字）" }, 400);
    const sidF = c.req.query("sid") || null;
    const limit = Math.min(Number(c.req.query("limit") ?? 60) || 60, 200);
    const db2 = getDatabase();
    const like = `%${q}%`;
    const args: any[] = sidF ? [like, sidF, like, sidF] : [like, like];
    const sidCond = sidF ? " AND m.session_id = ?" : "";
    const rows = db2
      .prepare(
        `SELECT session_id AS sessionId, title, role, content, created_at AS createdAt FROM (
           SELECT m.session_id, s.title, m.role, m.content, m.created_at
             FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.content LIKE ?${sidCond} AND m.role IN ('user','assistant')
           UNION ALL
           SELECT m.session_id, s.title, m.role, m.content, m.created_at
             FROM messages_archive m JOIN sessions s ON s.id = m.session_id
            WHERE m.content LIKE ?${sidCond} AND m.role IN ('user','assistant')
         ) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as any[];
    // 助手历史可能存 {text,toolCalls} JSON：提纯后再匹配，避免命中 JSON 噪声
    const clean = (role: string, content: string) => {
      if (role === "assistant") {
        try {
          const p = JSON.parse(content);
          if (p && typeof p === "object")
            return String(
              p.text ??
                (p.toolCalls?.length
                  ? "🔧 " + p.toolCalls.map((t: any) => t.name).join(", ")
                  : ""),
            );
        } catch {}
      }
      return content;
    };
    const ql = q.toLowerCase();
    const results: any[] = [];
    for (const r of rows) {
      const text = clean(r.role, r.content ?? "");
      const qi = text.toLowerCase().indexOf(ql);
      if (qi < 0) continue;
      const start = Math.max(0, qi - 80);
      const end = Math.min(text.length, qi + q.length + 160);
      results.push({
        sessionId: r.sessionId,
        title: r.title || "(未命名)",
        role: r.role,
        createdAt: r.createdAt,
        snippet:
          (start > 0 ? "…" : "") +
          text.slice(start, end).trim() +
          (end < text.length ? "…" : ""),
      });
    }
    return c.json({ query: q, total: results.length, results });
  });

  // MEMORY.md 读写（设置页记忆编辑器）
  app.get("/api/memory/content", async (c) =>
    c.json({ content: await memFor(c.req.query("agent")).readMemory() }),
  );
  app.put("/api/memory/content", async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    if (typeof body.content !== "string")
      return c.json({ error: "content 必须是字符串" }, 400);
    await memFor(c.req.query("agent")).writeMemory(body.content);
    return c.json({ ok: true });
  });

  // ── Token 用量 ──
  // 会话上下文占用：最新 prompt=当前上下文长度；末条用户消息后的 usage=最新一轮；
  // contextWindow 来自 provider 模型目录（查不到则只报 token 数）
  app.get("/api/sessions/:id/context", async (c) => {
    const id = c.req.param("id");
    const session = deps.sessions.get(id);
    if (!session) return c.json({ error: "not found" }, 404);
    const db2 = getDatabase();
    const model = session.model ?? deps.config.defaultModel;
    const info = await deps.llm.modelInfo(model);
    const last = db2
      .prepare(
        `SELECT prompt_tokens p, completion_tokens o, cached_read_tokens cr, cached_write_tokens cw,
                cost_usd cost, created_at FROM token_usage
         WHERE session_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id) as any;
    const lastUser = db2
      .prepare(
        `SELECT created_at FROM messages WHERE session_id=? AND role='user'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id) as any;
    const run = db2
      .prepare(
        `SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens),0) prompt,
                COALESCE(SUM(completion_tokens),0) completion,
                COALESCE(SUM(cached_read_tokens),0) cacheRead,
                COALESCE(SUM(cached_write_tokens),0) cacheWrite, SUM(cost_usd) cost
         FROM token_usage WHERE session_id=? AND created_at>=?`,
      )
      .get(id, lastUser?.created_at ?? 0) as any;
    const total = db2
      .prepare(
        `SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens),0) prompt,
                COALESCE(SUM(completion_tokens),0) completion, SUM(cost_usd) cost
         FROM token_usage WHERE session_id=?`,
      )
      .get(id) as any;
    const round = (v: any) => (v != null ? Math.round(v * 1e6) / 1e6 : null);
    run.cost = round(run.cost);
    total.cost = round(total.cost);
    return c.json({
      model,
      contextWindow: info?.contextWindow ?? null,
      // 当前上下文占用：最近一次调用的全量输入（含缓存读/写段）
      usedTokens: last?.p ?? null,
      lastRunAt: last?.created_at ?? null,
      lastRun: run,
      sessionTotal: total,
    });
  });

  app.get("/api/usage", (c) => {
    const db2 = getDatabase();
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    const since = Date.now() - days * 86400000;
    const totals = db2
      .prepare(
        `SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens),0) prompt,
                COALESCE(SUM(completion_tokens),0) completion,
                COALESCE(SUM(total_tokens),0) total,
                COALESCE(SUM(cached_read_tokens),0) cacheRead,
                COALESCE(SUM(cached_write_tokens),0) cacheWrite,
                SUM(cost_usd) cost,
                COALESCE(SUM(CASE WHEN cached_read_tokens + cached_write_tokens > 0
                                  THEN prompt_tokens ELSE 0 END),0) promptCacheable
         FROM token_usage WHERE created_at >= ?`,
      )
      .get(since) as any;
    // 计费成本：SUM 跳过 NULL（未知定价行）；全未知时 cost=null（不冒充 0）
    totals.cost = totals.cost != null ? Math.round(totals.cost * 1e6) / 1e6 : null;
    // 命中率两口径：
    // - cacheHitRate（整体）：被缓存段稀释（ollama/旧数据/首轮都算分母），保守偏低
    // - cacheHitRateActive（缓存在效内）：只统计网关真报了缓存字段的行 → 稳定可信
    totals.cacheHitRate =
      totals.prompt > 0 ? Math.min(1, totals.cacheRead / totals.prompt) : null;
    totals.cacheHitRateActive =
      totals.promptCacheable > 0
        ? Math.min(1, totals.cacheRead / totals.promptCacheable)
        : null;
    const daily = db2
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') day,
                SUM(prompt_tokens) prompt, SUM(completion_tokens) completion,
                SUM(total_tokens) total, COUNT(*) calls,
                SUM(cached_read_tokens) cacheRead, SUM(cached_write_tokens) cacheWrite,
                SUM(cost_usd) cost,
                SUM(CASE WHEN cached_read_tokens + cached_write_tokens > 0
                         THEN prompt_tokens ELSE 0 END) promptCacheable
         FROM token_usage WHERE created_at >= ?
         GROUP BY day ORDER BY day DESC LIMIT ?`,
      )
      .all(since, days + 2) as any[];
    const roundCost = (v: any) => (v != null ? Math.round(v * 1e6) / 1e6 : null);
    for (const d of daily) d.cost = roundCost(d.cost);
    const byModel = db2
      .prepare(
        `SELECT model, SUM(total_tokens) total, COUNT(*) calls,
                SUM(cached_read_tokens) cacheRead, SUM(cost_usd) cost
         FROM token_usage WHERE created_at >= ?
         GROUP BY model ORDER BY total DESC`,
      )
      .all(since) as any[];
    for (const m of byModel) m.cost = roundCost(m.cost);
    const byAgent = db2
      .prepare(
        `SELECT s.agent_id agent, SUM(t.total_tokens) total, COUNT(*) calls, SUM(t.cost_usd) cost
         FROM token_usage t JOIN sessions s ON s.id = t.session_id
         WHERE t.created_at >= ? GROUP BY s.agent_id ORDER BY total DESC`,
      )
      .all(since) as any[];
    for (const a of byAgent) a.cost = roundCost(a.cost);
    // 按 agent 的每日成本（2026-11-10 堆叠图）
    const dailyAgents = db2
      .prepare(
        `SELECT strftime('%Y-%m-%d', t.created_at/1000, 'unixepoch') day, s.agent_id agent,
                SUM(COALESCE(t.cost_usd,0)) cost, SUM(t.total_tokens) total
         FROM token_usage t JOIN sessions s ON s.id = t.session_id
         WHERE t.created_at >= ? GROUP BY day, agent ORDER BY day`,
      )
      .all(since) as any[];
    for (const x of dailyAgents) x.cost = roundCost(x.cost) ?? 0;
    // 预算护栏状态（今日已用，本地零点）
    let budget: any = null;
    if (deps.config.budget) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const spent = Number(
        (db2
          .prepare("SELECT COALESCE(SUM(cost_usd),0) c FROM token_usage WHERE created_at >= ?")
          .get(midnight.getTime()) as any)?.c ?? 0,
      );
      budget = { ...deps.config.budget, spentToday: Math.round(spent * 1e6) / 1e6 };
    }
    return c.json({ days, totals, daily: daily.reverse(), byModel, byAgent, dailyAgents, budget });
  });

  // ── 知识拓扑图：记忆知识点（向量相似）+ agent 归属 + 会话关联；?q= 切换为检索模式 ──
  app.get("/api/knowledge/graph", async (c) => {
    const db2 = getDatabase();
    const q = String(c.req.query("q") ?? "").trim();
    const minSim = Math.min(Math.max(Number(c.req.query("minSim") ?? 0.35), 0), 0.99);
    // 隔离后的作用域（2026-10-30）：agent=<name> 只看该 agent 的知识/会话；缺省/all=全局
    const agentScope = String(c.req.query("agent") ?? "").trim();
    const MAX_ENTRIES = 150;

    const cos=(a:Float32Array,b:Float32Array)=>{
      const n=Math.min(a.length,b.length); if(!n)return 0;
      let dot=0,na=0,nb=0;
      for(let i=0;i<n;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
      return na&&nb?dot/Math.sqrt(na*nb):0;
    };

    // 1) 知识点节点（memory_entries 最新 N 条 + 向量）；作用域内先滤（多取候选再裁）
    const entries = db2
      .prepare(
        `SELECT id, source, file_path, excerpt, updated_at FROM memory_entries
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(agentScope && agentScope !== "all" ? MAX_ENTRIES * 4 : MAX_ENTRIES) as any[];
    const vecMap = new Map<number, Float32Array>();
    try {
      for (const r of db2.prepare("SELECT id, embedding FROM memory_vec").all() as any[]) {
        if (r.embedding) vecMap.set(r.id, new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4));
      }
    } catch {}

    // 2) agent 归属：file_path 按 workspaceDir 最长前缀匹配；
    //    会话语料（.dreams/session-corpus/<md5(sid)前12位>.md）反查会话→agent，
    //    共享工作区的多 agent 也能把知识挂对各自主人
    const agentList = Object.values(deps.agents ?? {}) as any[];
    const ownerOf = (fp: string): string | null => {
      let best: string | null = null, bl = -1;
      for (const a of agentList) {
        const wd = String(a.workspaceDir ?? "");
        if (wd && fp.startsWith(wd) && wd.length > bl) { best = a.name; bl = wd.length; }
      }
      return best;
    };
    const corpusOwner = new Map<string, { agent: string | null; sessionId: string }>();
    try {
      const { createHash } = await import("node:crypto");
      for (const s of db2.prepare("SELECT id, agent_id FROM sessions").all() as any[]) {
        const h = createHash("md5").update(s.id).digest("hex").slice(0, 12);
        corpusOwner.set(h, { agent: s.agent_id ?? null, sessionId: s.id });
      }
    } catch {}

    const nodes: any[] = [];
    const edges: any[] = [];
    // 关联边：agent 配了 relatedAgents 则在图上可视化（如 tech→default 二查通道；
    // 通配符 "*" = 全索引型 agent，展开到全部其他 agent）
    for (const a of agentList) {
      const relRaw = ((a as any).relatedAgents ?? []) as string[];
      const rel = relRaw.includes("*")
        ? agentList.map((x: any) => x.name).filter((n: string) => n !== a.name)
        : relRaw;
      for (const r of rel) {
        if (r !== a.name && agentList.some((x: any) => x.name === r))
          edges.push({ from: `a:${a.name}`, to: `a:${r}`, kind: "related" });
      }
    }
    const ownerOfEntry = (fp: string): string | null => {
      const corpus = String(fp).match(/session-corpus\/([0-9a-f]{12})\.md$/);
      return corpus ? corpusOwner.get(corpus[1])?.agent ?? ownerOf(String(fp)) : ownerOf(String(fp));
    };
    const scoped =
      !agentScope || agentScope === "all"
        ? entries
        : entries.filter((e: any) => ownerOfEntry(e.file_path) === agentScope).slice(0, MAX_ENTRIES);
    const shownAgents =
      !agentScope || agentScope === "all" ? agentList : agentList.filter((a: any) => a.name === agentScope);
    for (const a of shownAgents) {
      nodes.push({ id: `a:${a.name}`, type: "agent", label: a.name, sub: (a.model || "").split("/").pop() });
    }
    const entryLabel = (e: any, _i: number) => {
      const m = String(e.file_path).match(/session-corpus\/([0-9a-f]{12})\.md$/);
      if (m) {
        const own = corpusOwner.get(m[1]);
        const title = own ? (db2.prepare("SELECT title FROM sessions WHERE id=?").get(own.sessionId) as any)?.title : null;
        return `${(title || own?.agent || "会话").slice(0, 10)}·语料#${e.id}`;
      }
      const base = String(e.file_path).split("/").pop() ?? "?";
      return `${base.replace(/\.md$/, "")}#${e.id}`;
    };
    let kept = scoped;

    if (q && deps.embedding) {
      // 检索模式：query 为中心，只展 top 命中 + 命中间相似边
      try {
        const qv = await deps.embedding.embed(q);
        const scored = scoped
          .map((e) => ({ e, s: vecMap.has(e.id) ? cos(qv, vecMap.get(e.id)!) : 0 }))
          .filter((x) => x.s >= 0.15)
          .sort((x, y) => y.s - x.s)
          .slice(0, 10);
        kept = scored.map((x) => x.e);
        nodes.push({ id: "q", type: "query", label: q, sub: `${kept.length} 个知识点命中` });
        for (const { e, s } of scored) {
          edges.push({ from: "q", to: `m${e.id}`, kind: "hit", weight: Math.round(s * 100) / 100 });
        }
      } catch (err: any) {
        return c.json({ error: "嵌入查询失败：" + String(err?.message ?? err).slice(0, 120) }, 502);
      }
    }

    const involvedAgents = new Set<string>();
    for (const e of kept) {
      const corpus = String(e.file_path).match(/session-corpus\/([0-9a-f]{12})\.md$/);
      const owner = ownerOfEntry(String(e.file_path));
      if (owner) involvedAgents.add(owner);
      nodes.push({
        id: `m${e.id}`, type: "memory", label: entryLabel(e, 0),
        sub: e.source, file: e.file_path,
        excerpt: String(e.excerpt ?? "").slice(0, 600), agent: owner, updatedAt: e.updated_at,
      });
      if (corpus && corpusOwner.get(corpus[1])) {
        edges.push({ from: `s:${corpusOwner.get(corpus[1])!.sessionId}`, to: `m${e.id}`, kind: "corpus" });
      } else if (owner) {
        edges.push({ from: `a:${owner}`, to: `m${e.id}`, kind: "file" });
      }
    }

    // 3) 知识点间相似边（余弦 ≥ minSim，每人 top3，防糊成一团）
    if (kept.length > 1) {
      const withVec = kept.filter((e: any) => vecMap.has(e.id));
      const topK = new Map<number, { id: number; s: number }[]>();
      for (let i = 0; i < withVec.length; i++) {
        for (let j = i + 1; j < withVec.length; j++) {
          const s = cos(vecMap.get(withVec[i].id)!, vecMap.get(withVec[j].id)!);
          if (s < minSim) continue;
          for (const [a, b] of [[withVec[i].id, withVec[j].id], [withVec[j].id, withVec[i].id]]) {
            const list = topK.get(a) ?? [];
            list.push({ id: b, s });
            topK.set(a, list);
          }
        }
      }
      const seen = new Set<string>();
      for (const [a, list] of topK) {
        list.sort((x, y) => y.s - x.s).slice(0, 3);
        for (const { id: b, s } of list) {
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: `m${a}`, to: `m${b}`, kind: "similar", weight: Math.round(s * 100) / 100 });
        }
      }
    }

    // 4) 会话节点（全图/检索模式都显示，挂在各自 agent 下）
    for (const a of shownAgents) {
      const sess = db2.prepare(
        `SELECT id, title, model, updated_at FROM sessions
         WHERE agent_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 3`,
      ).all(a.name) as any[];
      for (const s of sess) {
        nodes.push({ id: `s:${s.id}`, type: "session", label: (s.title || "会话").slice(0, 20), sub: (s.model || "").split("/").pop(), agent: a.name });
        edges.push({ from: `a:${a.name}`, to: `s:${s.id}`, kind: "owns" });
      }
    }

    return c.json({
      query: q || null,
      scope: agentScope || "all",
      agents: shownAgents.map((a) => a.name),
      entryTotal: db2.prepare("SELECT COUNT(*) n FROM memory_entries").get(),
      nodes, edges,
    });
  });

  // ── 定时任务 / 事件 watcher ──
  app.get("/api/cron", (c) => c.json({ jobs: deps.cron ? deps.cron.list() : [] }));
  app.post("/api/cron", async (c) => {
    if (!deps.cron) return c.json({ error: "cron 不可用" }, 503);
    const body = await c.req.json().catch(() => null as any);
    if (!body?.schedule?.kind || !body?.payload?.kind)
      return c.json({ error: "需要 schedule.kind 和 payload.kind" }, 400);
    if (body.schedule.kind === "watch" && !body.schedule.command)
      return c.json({ error: "watch 任务需要 schedule.command" }, 400);
    if (body.payload?.agent && !deps.agents[body.payload.agent])
      return c.json({ error: `payload.agent "${body.payload.agent}" 不存在（可用：${Object.keys(deps.agents).join(", ")}）` }, 400);
    try {
      const id = deps.cron.create({
        name: body.name ?? "job",
        description: body.description,
        schedule: body.schedule,
        payload: body.payload,
        sessionTarget: body.sessionTarget ?? "isolated",
        enabled: body.enabled !== false,
      });
      return c.json({ id }, 201);
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e) }, 400);
    }
  });
  app.delete("/api/cron/:id", (c) => {
    if (!deps.cron) return c.json({ error: "cron 不可用" }, 503);
    deps.cron.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── 发件箱（2026-11-10）：网关告警/cron 定向投递统一写入，wecom 桥接轮询消费 ──
  app.post("/api/outbox", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const chatId = String(body.chatId ?? deps.config.wecom?.alertChatId ?? "");
    const text = String(body.text ?? "").slice(0, 8000);
    if (!chatId || !text.trim())
      return c.json({ error: "需要 chatId（或配置 wecom.alertChatId）与 text" }, 400);
    const r = getDatabase()
      .prepare("INSERT INTO outbox (chat_id, text, created_at) VALUES (?,?,?)")
      .run(chatId, text, Date.now());
    return c.json({ id: Number(r.lastInsertRowid) }, 201);
  });
  app.get("/api/outbox", (c) => {
    const rows = getDatabase()
      .prepare(
        "SELECT id, chat_id as chatId, text, created_at as createdAt FROM outbox WHERE sent_at IS NULL ORDER BY id ASC LIMIT 20",
      )
      .all();
    return c.json({ pending: rows });
  });
  app.post("/api/outbox/:id/ack", (c) => {
    getDatabase()
      .prepare("UPDATE outbox SET sent_at = ? WHERE id = ?")
      .run(Date.now(), Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // ── 工具审批（2026-11-10 接通 PermissionManager ask/deny）──
  app.get("/api/approvals", (c) => {
    const rows = getDatabase()
      .prepare(
        `SELECT id, session_id as sessionId, agent_id as agent, tool_name as tool,
                detail, reason, created_at as createdAt
         FROM approvals WHERE status = 'pending' ORDER BY id ASC LIMIT 20`,
      )
      .all();
    return c.json({ pending: rows, enabled: !!deps.config.approvals?.enabled });
  });
  app.post("/api/approvals/:id/resolve", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const status = body.action === "allow" ? "allowed" : body.action === "deny" ? "denied" : null;
    if (!status) return c.json({ error: "action 必须是 allow|deny" }, 400);
    const r = getDatabase()
      .prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, Date.now(), Number(c.req.param("id")));
    return c.json({ ok: r.changes > 0 });
  });

  // 会话导出（2026-11-10）：md（人类读）/ json（机器）；含归档全量历史
  app.get("/api/sessions/:id/export", (c) => {
    const id = c.req.param("id");
    const sess = deps.sessions.get(id);
    if (!sess) return c.json({ error: "not found" }, 404);
    const fmt = c.req.query("format") === "json" ? "json" : "md";
    const msgs = deps.sessions.getFullMessages(id);
    const safeTitle = (sess.title ?? "会话").replace(/["\\/]/g, "_").slice(0, 40);
    if (fmt === "json") {
      return c.json({ session: sess, messages: msgs });
    }
    const ROLE: Record<string, string> = { user: "👤 用户", assistant: "🤖 助手", system: "⚙️ 系统", tool: "🔧 工具" };
    const lines = [`# ${sess.title ?? "未命名会话"}`, "", `- agent: ${sess.agentId} · model: ${sess.model} · ${msgs.length} 条`, ""];
    for (const m of msgs as any[]) {
      const time = m.createdAt ? new Date(m.createdAt).toLocaleString("zh-CN") : "";
      let text = String(m.content ?? "");
      try {
        const p = JSON.parse(text);
        if (p && typeof p === "object") {
          const names = Array.isArray(p.toolCalls) ? p.toolCalls.map((t: any) => t.name).join(",") : "";
          text = `${p.text ?? ""}${names ? `\n（调用工具：${names}）` : ""}`;
        }
      } catch {}
      lines.push(`## ${ROLE[m.role] ?? m.role} · ${time}${m.archived ? " ·[已归档]" : ""}`, "", text.trim() || "（空）", "");
    }
    // 文件名可能含中文 → RFC 5987 编码（裸中文头值非法，会导致整个 headers 被丢弃）
    const fname = encodeURIComponent(`session-${safeTitle}.md`);
    return c.body(lines.join("\n"), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="session-export.md"; filename*=UTF-8''${fname}`,
    });
  });

  // ── 技能管理（2026-11-10）：工作区 skills/<name>/SKILL.md 的 CRUD + 触发词测试 ──
  const SKILL_NAME = /^[\w\u4e00-\u9fa5-]{1,40}$/;
  function skillWorkspace(agentName?: string): string | null {
    const a = agentName ? deps.agents[agentName] : deps.agents[Object.keys(deps.agents)[0]];
    return (a as any)?.workspaceDir ?? null;
  }
  app.get("/api/skills", async (c) => {
    const wd = skillWorkspace(c.req.query("agent") || undefined);
    if (!wd) return c.json({ error: "agent 不存在" }, 404);
    const sm = new SkillManager(path.join(wd, "skills"));
    await sm.scan();
    return c.json({
      workspace: wd,
      skills: sm.list().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers })),
    });
  });
  app.get("/api/skills/:name", async (c) => {
    const wd = skillWorkspace(c.req.query("agent") || undefined);
    if (!wd) return c.json({ error: "agent 不存在" }, 404);
    const file = path.join(wd, "skills", c.req.param("name"), "SKILL.md");
    try {
      return c.json({ markdown: await fs.promises.readFile(file, "utf-8") });
    } catch {
      return c.json({ error: "技能不存在" }, 404);
    }
  });
  app.put("/api/skills/:name", async (c) => {
    const wd = skillWorkspace(c.req.query("agent") || undefined);
    if (!wd) return c.json({ error: "agent 不存在" }, 404);
    const name = c.req.param("name");
    if (!SKILL_NAME.test(name)) return c.json({ error: "技能名只允许字母数字中文_-（≤40）" }, 400);
    const body = await c.req.json().catch(() => ({} as any));
    let md = String(body.markdown ?? "");
    if (!md.startsWith("---")) {
      const tr = Array.isArray(body.triggers) ? `[${body.triggers.map((t: string) => JSON.stringify(t)).join(",")}]` : "[]";
      md = `---\nname: ${name}\ndescription: ${body.description ?? ""}\ntriggers: ${tr}\n---\n\n${body.body ?? "# 使用说明"}\n`;
    }
    const dir = path.join(wd, "skills", name);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "SKILL.md"), md, "utf-8");
    return c.json({ ok: true, file: path.join(dir, "SKILL.md") });
  });
  app.delete("/api/skills/:name", async (c) => {
    const wd = skillWorkspace(c.req.query("agent") || undefined);
    if (!wd) return c.json({ error: "agent 不存在" }, 404);
    const name = c.req.param("name");
    if (!SKILL_NAME.test(name)) return c.json({ error: "非法技能名" }, 400);
    const dir = path.join(wd, "skills", name);
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json({ error: String(e?.message) }, 500);
    }
  });
  app.post("/api/skills/test", async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    const wd = skillWorkspace(body.agent || undefined);
    if (!wd) return c.json({ error: "agent 不存在" }, 404);
    const sm = new SkillManager(path.join(wd, "skills"));
    await sm.scan();
    const hit = sm.match(String(body.text ?? ""));
    return c.json({ matched: hit ? hit.name : null, total: sm.list().length });
  });

  // 子 Agent 运行记录（拓扑数据）
  app.get("/api/subagents", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ runs: listRuns(limit), running: runningCount() });
  });

  // 任意步中断：abort 进行中会话的 run 循环（LLM 请求/子进程随之终止）
  app.post("/api/sessions/:id/abort", (c) => {
    const id = c.req.param("id");
    const ok = deps.sessions.abort(id);
    if (ok) emitEvents(id, { sessionId: id, ts: Date.now(), type: "aborted" });
    return c.json({ ok });
  });

  // SSE 事件流：进行中会话的逐字文本增量 / 工具执行 / 运行边界实时推送
  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const unsub = subscribeEvents(id, (e) => {
        stream.writeSSE({ data: JSON.stringify(e) }).catch(() => unsub());
      });
      await stream.writeSSE({
        data: JSON.stringify({ type: "ready", sessionId: id }),
      });
      let stopped = false;
      stream.onAbort(() => {
        stopped = true;
      });
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 15000));
        if (stopped) break;
        try {
          await stream.writeSSE({ data: JSON.stringify({ type: "ping" }) });
        } catch {
          break;
        }
      }
      unsub();
    });
  });

  app.get("/api/tools", (c) => c.json({ tools: deps.tools.getDefinitions() }));

  // 检索管道状态（拓扑图）：embedding/FTS/vec/精排配置 + 各层实时数据
  app.get("/api/retrieval", (c) => {
    if (!deps.getRetrievalStats) return c.json({ error: "retrieval stats unavailable" }, 503);
    return c.json(deps.getRetrievalStats());
  });

  // 立即重建知识索引（不等 10 分钟周期）：新文档/搬运的记忆秒进知识拓扑
  app.post("/api/reindex", async (c) => {
    if (!deps.reindex) return c.json({ error: "reindex unavailable" }, 503);
    try {
      return c.json(await deps.reindex());
    } catch (e: any) {
      return c.json({ error: String(e?.message ?? e).slice(0, 200) }, 500);
    }
  });

  return app;
}
