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

export interface ServerDeps {
  llm: LLMClient;
  sessions: SessionManager;
  tools: ToolRegistry;
  searcher: MemorySearcher;
  memory: BasicMemory;
  config: any;
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

  app.get("/api/sessions", (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json({ sessions: deps.sessions.list(limit) });
  });

  app.post("/api/sessions", async (c) => {
    const body = await c.req.json();
    const systemPrompt = await deps.memory.buildSystemPrompt();
    const session = deps.sessions.create({
      model: body.model ?? deps.config.defaultModel,
      systemPrompt,
    });
    return c.json({ session }, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const s = deps.sessions.get(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    return c.json({ session: s });
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
