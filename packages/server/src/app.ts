import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { LLMClient } from "@easy-agent/llm/client";
import type { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import type { MemorySearcher } from "@easy-agent/memory/search";
import type { BasicMemory } from "@easy-agent/core/memory/basic";
import { serveStatic } from "hono/bun";
import { Observability } from "@easy-agent/core/observability";
import { getDatabase } from "@easy-agent/core/database";
import { loadSettings, saveSettings } from "./settings.js";
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
}

export interface ServerDeps {
  llm: LLMClient;
  sessions: SessionManager;
  tools: ToolRegistry;
  searcher: MemorySearcher;
  memory: BasicMemory;
  config: any;
  /** 多 Agent：name -> 运行时（模型/工作区/记忆） */
  agents: Record<string, AgentRuntime>;
  /** 梦境单轮执行器（index.ts 注入：接线 + 防并发） */
  runDreaming?: () => Promise<Record<string, unknown>>;
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  app.use("*", cors());
  app.use("*", logger());

  app.use(
    "/static/*",
    serveStatic({
      root: resolvePublicDir(),
      rewriteRequestPath: (p) => p.replace(/^\/static/, ""),
    }),
  );
  app.get("/", (c) => c.redirect("/static/index.html"));

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
      })),
    }),
  );

  // 首页会话：每个 agent 自动获得一个置顶、不可删除的固定会话
  async function ensureHomeSession(agentName: string): Promise<void> {
    const rt = deps.agents[agentName];
    if (!rt) return;
    if (deps.sessions.list(50, agentName).some((s) => s.pinned)) return;
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
    const session = deps.sessions.create({
      agentId: agent.name,
      model: body.model ?? agent.model,
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

  // Agent 拓扑：节点=agent（当前工作/活跃度），边=sub-agent 派生关系
  app.get("/api/topology", (c) => {
    const db = getDatabase();
    const nowTs = Date.now();

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
      const sub = db
        .prepare(
          `SELECT COUNT(*) n FROM tool_calls tc
           JOIN sessions s ON tc.session_id = s.id
           WHERE s.agent_id = ? AND tc.tool_name = 'sub-agent'`,
        )
        .get(a.name) as any;

      return {
        name: a.name,
        model: a.model,
        description: a.description,
        thinking: a.thinking,
        sessions: agg?.c ?? 0,
        lastActive: agg?.last ?? 0,
        busy: nowTs - (agg?.last ?? 0) < 120000, // 2 分钟内有更新
        subAgentCalls: sub?.n ?? 0,
        currentTasks: (tasks ?? []).map((t) => ({
          id: t.id,
          title: t.title ?? "untitled",
          model: t.model,
          msgCount: t.msg_count,
          ageSec: Math.max(0, Math.round((nowTs - t.updated_at) / 1000)),
        })),
      };
    });

    const edges = nodes
      .filter((n) => n.subAgentCalls > 0)
      .map((n) => ({ from: n.name, to: "sub-agents", weight: n.subAgentCalls }));

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

  app.get("/api/sessions/:id/messages", (c) => {
    return c.json({ messages: deps.sessions.getMessages(c.req.param("id")) });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const body = await c.req.json();
    const id = c.req.param("id");
    const sess = deps.sessions.get(id);
    const agent = sess ? deps.agents[sess.agentId] : undefined;
    const response = await deps.sessions.run(id, body.text, {
      toolRegistry: deps.tools,
      thinking: agent?.thinking as
        | "off"
        | "low"
        | "medium"
        | "high"
        | undefined,
    });
    return c.json({ response });
  });

  // Agent 运行时参数修改（思考等级）：即时生效 + 持久化到 agents-state.json，
  // 重启网关后由 loadConfig 叠加回配置（Web UI 无需改文件即可配置）
  app.patch("/api/agents/:name", async (c) => {
    const name = c.req.param("name");
    const agent = deps.agents[name];
    if (!agent) return c.json({ error: `unknown agent: ${name}` }, 404);
    const body = await c.req.json().catch(() => ({}) as any);
    const levels = ["off", "low", "medium", "high"];
    if (typeof body.thinking !== "string")
      return c.json({ error: "thinking 必须是字符串" }, 400);
    if (!levels.includes(body.thinking))
      return c.json({ error: "thinking 必须是 off|low|medium|high" }, 400);

    agent.thinking = body.thinking;
    try {
      const dir = deps.config.stateDir;
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "agents-state.json");
      let data: any = {};
      try {
        data = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {}
      data.agents = {
        ...(data.agents ?? {}),
        [name]: { ...(data.agents?.[name] ?? {}), thinking: body.thinking },
      };
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e: any) {
      return c.json({ error: `设置已生效但持久化失败: ${e.message}` }, 500);
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

  app.get("/api/memory/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "missing q" }, 400);
    return c.json(await deps.searcher.search(q));
  });

  app.get("/api/memory/file", async (c) => {
    const p = c.req.query("path");
    if (!p) return c.json({ error: "missing path" }, 400);
    return c.json(await deps.memory.readMemory());
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

  // MEMORY.md 读写（设置页记忆编辑器）
  app.get("/api/memory/content", async (c) =>
    c.json({ content: await deps.memory.readMemory() }),
  );
  app.put("/api/memory/content", async (c) => {
    const body = await c.req.json().catch(() => ({}) as any);
    if (typeof body.content !== "string")
      return c.json({ error: "content 必须是字符串" }, 400);
    await deps.memory.writeMemory(body.content);
    return c.json({ ok: true });
  });

  // ── Token 用量 ──
  app.get("/api/usage", (c) => {
    const db2 = getDatabase();
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    const since = Date.now() - days * 86400000;
    const totals = db2
      .prepare(
        `SELECT COUNT(*) calls, COALESCE(SUM(prompt_tokens),0) prompt,
                COALESCE(SUM(completion_tokens),0) completion,
                COALESCE(SUM(total_tokens),0) total
         FROM token_usage WHERE created_at >= ?`,
      )
      .get(since) as any;
    const daily = db2
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') day,
                SUM(prompt_tokens) prompt, SUM(completion_tokens) completion,
                SUM(total_tokens) total, COUNT(*) calls
         FROM token_usage WHERE created_at >= ?
         GROUP BY day ORDER BY day DESC LIMIT ?`,
      )
      .all(since, days + 2) as any[];
    const byModel = db2
      .prepare(
        `SELECT model, SUM(total_tokens) total, COUNT(*) calls
         FROM token_usage WHERE created_at >= ?
         GROUP BY model ORDER BY total DESC`,
      )
      .all(since) as any[];
    const byAgent = db2
      .prepare(
        `SELECT s.agent_id agent, SUM(t.total_tokens) total, COUNT(*) calls
         FROM token_usage t JOIN sessions s ON s.id = t.session_id
         WHERE t.created_at >= ? GROUP BY s.agent_id ORDER BY total DESC`,
      )
      .all(since) as any[];
    return c.json({ days, totals, daily: daily.reverse(), byModel, byAgent });
  });

  app.get("/api/tools", (c) => c.json({ tools: deps.tools.getDefinitions() }));

  return app;
}
