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
      })),
    }),
  );

  app.get("/api/sessions", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const agent = c.req.query("agent") || undefined;
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
    deps.sessions.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/sessions/:id/messages", (c) => {
    return c.json({ messages: deps.sessions.getMessages(c.req.param("id")) });
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const body = await c.req.json();
    const response = await deps.sessions.run(c.req.param("id"), body.text, {
      toolRegistry: deps.tools,
    });
    return c.json({ response });
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

  app.get("/api/tools", (c) => c.json({ tools: deps.tools.getDefinitions() }));

  return app;
}
