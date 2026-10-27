import { serve } from "@hono/node-server";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";
import { MemorySearcher } from "@easy-agent/memory/search";
import { ShortTermMemory } from "@easy-agent/memory/short-term";
import { createMemorySearchTool } from "@easy-agent/memory/tool";
import { HybridSearch } from "@easy-agent/memory/hybrid-search";
import { IncrementalIndex } from "@easy-agent/memory/incremental-index";
import {
  SimpleEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  type EmbeddingProvider,
} from "@easy-agent/memory/embedding";
import { createWebsearchTool } from "@easy-agent/core/tool/builtins/websearch";
import { SubAgentManager } from "@easy-agent/core/agent/sub-agent";
import { createSubAgentTool } from "@easy-agent/core/agent/sub-agent-tool";
import { createVisionTool } from "@easy-agent/core/tool/builtins/vision";
import { ImageGenerator } from "@easy-agent/core/image-gen/index";
import { createImageGenTool } from "@easy-agent/core/tool/builtins/image-gen";
import { createTraeTool } from "@easy-agent/core/tool/builtins/trae-agent";
import { createAcpAgentTool } from "@easy-agent/core/tool/builtins/acp-agent";
import { MonitoringSystem } from "@easy-agent/core/monitoring/index";

import { loadConfig } from "@easy-agent/config/loader";
import { modelFallbackMap, resolveImageGenModelId, resolveAgents } from "@easy-agent/config/models";
import { loadSettings } from "./settings.js";
import {
  lightDreaming,
  remDreaming,
  deepDreaming,
  loadDreamingConfig,
} from "@easy-agent/memory/dreaming";
import { BackupManager } from "@easy-agent/core/backup/index";
import { getDatabase } from "@easy-agent/core/database";
import { CronManager } from "@easy-agent/core/cron/index";
import { CronScheduler } from "@easy-agent/core/cron/scheduler";
import { initSecretMask, maskSecrets } from "@easy-agent/core/secrets-mask";
import { execSync } from "node:child_process";
import net from "node:net";

/**
 * 端口预检：@hono/node-server 的 listen 错误是异步抛出的，
 * 同步 try/catch 拦不住，唯一可靠做法是先探测再启动。
 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (e: any) => {
      probe.removeAllListeners();
      resolve(e?.code === "EADDRINUSE");
    });
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port);
  });
}

async function main() {
  const config = loadConfig();
  const db = getDatabase();

  const llm = new LLMClient({ providers: config.providers, fallbacks: modelFallbackMap(config) });
  const sessions = new SessionManager(llm, {
    defaultModel: config.defaultModel,
  });
  const tools = new ToolRegistry();
  const workspaceDir = config.workspaceDir || process.cwd();
  const memory = new BasicMemory(workspaceDir);
  const memoryDir = `${workspaceDir}/memory`;
  const searcher = new MemorySearcher(workspaceDir, memoryDir);
  const shortTerm = new ShortTermMemory(db);

  // 搜索命中 -> 短期记忆 recall 统计（Dreaming 晋升依据）
  searcher.onHit = (filePath) => shortTerm.incrementRecall(filePath);

  // ── 向量/混合检索（config.memorySearch 可配）──
  // embedding.provider: simple(零依赖离线) | ollama(本地真模型) | openai(需 key)
  // hybrid.enabled=false 退回纯关键词；权重可调；无模型时向量通道自动缺席
  const msCfg: any = (config as any).memorySearch ?? {};
  const embCfg: any = msCfg.embedding ?? { provider: "simple" };
  let embedding: EmbeddingProvider;
  if (embCfg.provider === "ollama") {
    embedding = new OllamaEmbeddingProvider({
      baseUrl: embCfg.baseUrl ?? config.providers.ollama?.baseUrl,
      model: embCfg.model ?? "nomic-embed-text",
    });
  } else if (embCfg.provider === "openai" && (embCfg.apiKey || config.providers.openai?.apiKey)) {
    embedding = new OpenAIEmbeddingProvider({
      apiKey: embCfg.apiKey ?? config.providers.openai?.apiKey ?? "",
      baseUrl: embCfg.baseUrl,
      model: embCfg.model,
    });
  } else {
    embedding = new SimpleEmbeddingProvider();
  }
  const memIndex = new IncrementalIndex(
    db,
    embedding,
    embCfg.provider === "ollama" || embCfg.provider === "openai" ? 1024 : 256,
    embCfg.provider === "ollama"
      ? `ollama:${embCfg.model ?? "nomic-embed-text"}`
      : embCfg.provider === "openai"
        ? `openai:${embCfg.model ?? "text-embedding-3-small"}`
        : "simple",
  );
  // 会话语料摄取：活跃会话消息 → memory/.dreams/session-corpus/<hash>.md → 索引进知识网
  const { SessionIngester } = await import("@easy-agent/memory/ingestion");
  const sessionIngester = new SessionIngester(db, memoryDir);
  const hybrid =
    msCfg.hybrid?.enabled !== false
      ? new HybridSearch(searcher, embedding, workspaceDir, memIndex.fts, memIndex.vec, db, msCfg.rerank ?? {})
      : undefined;

  // 索引集与 MemorySearcher 的 corpus 对齐：工作区 md + memory/ + .dreams/session-corpus
  async function collectIndexableMdFiles(dir: string, includeDot = false): Promise<string[]> {
    const out: string[] = [];
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // .dreams 是会话语料目录，需要摄取；其余点目录跳过
        if (e.name.startsWith(".") && e.name !== ".dreams" && !includeDot) continue;
        out.push(...(await collectIndexableMdFiles(p, p.includes(".dreams") || includeDot)));
      } else if (e.name.endsWith(".md") && !e.name.startsWith(".")) out.push(p);
    }
    return out;
  }
  let indexBusy = false;
  async function reindexMemory(): Promise<{ files: number; chunks: number }> {
    if (indexBusy) return { files: 0, chunks: 0 };
    indexBusy = true;
    let files = 0,
      chunks = 0;
    try {
      // 先摄取活跃会话语料（失败不阻断文件索引）
      try {
        for (const s of sessions.list(50)) {
          const msgs = sessions.getMessages(s.id)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => {
              if (m.role === "user") return { role: m.role, content: m.content };
              // assistant 存的是 JSON{text,toolCalls}，只取可读文本
              try {
                const p = JSON.parse(m.content);
                return { role: m.role, content: typeof p?.text === "string" ? p.text : m.content };
              } catch {
                return { role: m.role, content: m.content };
              }
            });
          if (msgs.length) await sessionIngester.ingest(s.id, msgs);
        }
      } catch (e: any) {
        console.warn("📥 会话摄取失败:", String(e?.message).slice(0, 120));
      }
      const targets = [
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "USER.md"),
        ...(await collectIndexableMdFiles(memoryDir)),
      ];
      for (const f of targets) {
        if (!(await fs.stat(f).then(() => true, () => false))) continue;
        const src = f.includes(".dreams") ? "session" as const : "memory" as const;
        const rel = path.relative(workspaceDir, f);
        chunks += await memIndex.indexFile(f, src, rel);
        files++;
      }
    } finally {
      indexBusy = false;
    }
    return { files, chunks };
  }

  // 启动后后台建索引（不阻塞监听）+ 周期重检（hash 未变近乎零成本）
  setTimeout(() => {
    reindexMemory()
      .then((r) => r.chunks && console.log(`🧠 记忆向量索引: ${r.files} 文件 / ${r.chunks} 块`))
      .catch((e) => console.warn("🧠 索引失败:", String(e?.message).slice(0, 120)));
    const minutes = msCfg.reindexIntervalMinutes ?? 10;
    setInterval(() => {
      reindexMemory().catch(() => {});
    }, minutes * 60000);
  }, 5000);

  // memory_search 注册进工具表（混合检索可用时走 向量+全文 融合）
  tools.register(
    createMemorySearchTool(searcher, {
      hybrid,
      weights: msCfg.hybrid,
    }),
  );

  // websearch：按配置选后端（Tavily/Brave/Bocha key，无 key 回退 Bing 抓取），覆盖内置默认实例
  tools.register(
    createWebsearchTool((config as any).websearch ?? {}),
  );

  // Week5 Step 3：子 Agent 工具
  const subAgents = new SubAgentManager(
    sessions,
    tools,
    llm,
    config.defaultModel,
  );
  tools.register(createSubAgentTool(subAgents, () => agents));

  // Week6: Vision 工具（图片理解）
  tools.register(createVisionTool(config.visionModel ?? config.defaultModel));

  // Week8: 图片生成工具
  tools.register(
    createImageGenTool(
      new ImageGenerator({
        baseUrl: config.providers.openai?.baseUrl,
        model: resolveImageGenModelId(config),
      }),
    ),
  );

  // 工具裁剪：配置 tools.disable=[...] 注销对应工具（对所有 agent 生效）
  for (const name of config.tools?.disable ?? []) tools.unregister(name);

  // Week8: 监控告警（默认规则：库过大/错误率飙升）
  const monitoring = new MonitoringSystem();
  monitoring.addDefaultRules(async (msg) => console.error(msg));
  monitoring.start(60000);

  // 多 Agent：每个 agent 独立模型/工作区记忆（同工作区复用同一 BasicMemory）
  const agents: Record<string, any> = {};
  const memCache = new Map<string, BasicMemory>();
  for (const a of resolveAgents(config)) {
    let mem = memCache.get(a.workspaceDir);
    if (!mem) {
      mem = new BasicMemory(a.workspaceDir);
      const fresh = await mem.initWorkspace();
      // TOOLS.md 自动生成：工具清单落盘到工作区（供 agent/用户阅读）
      await fs.writeFile(
        path.join(a.workspaceDir, "TOOLS.md"),
        tools.toMarkdown(),
        "utf-8",
      ).catch(() => {});
      if (fresh.length)
        console.log(`📁 工作区 ${a.workspaceDir} 初始化: ${fresh.join(", ")}`);
      memCache.set(a.workspaceDir, mem);
    }
    agents[a.name] = {
      name: a.name,
      model: a.model,
      description: a.description,
      workspaceDir: a.workspaceDir,
      thinking: a.thinking,
      toolsDisable: a.toolsDisable,
      toolHint: a.toolHint,
      memory: mem,
    };
  }
  console.log(`🤖 Agents: ${Object.keys(agents).join(", ")}`);

  // 外部编码 agent（trae-cli headless）：配置 trae 节才注册；缺省围栏=各 agent 工作区
  // （必须在 agents 构建之后：引用 workspaceDir）
  if ((config as any).trae && (config as any).trae.enabled !== false) {
    const traeCfg = { ...(config as any).trae };
    if (!traeCfg.allowedWorkdirs?.length)
      traeCfg.allowedWorkdirs = Object.values(agents).map((a: any) => a.workspaceDir);
    tools.register(createTraeTool(traeCfg));
  }

  // ACP 长会话 agent（方案 B）：配置 acp.agents 非空才注册
  if ((config as any).acp?.agents && Object.keys((config as any).acp.agents).length > 0) {
    const acpCfg = { ...(config as any).acp };
    if (!acpCfg.allowedWorkdirs?.length)
      acpCfg.allowedWorkdirs = Object.values(agents).map((a: any) => a.workspaceDir);
    tools.register(createAcpAgentTool(acpCfg));
  }

  // 梦境（Dreaming）：浅眠→REM→深眠，短期记忆提炼晋升；设置页与调度器共用
  const dreamDeps = {
    db,
    shortTerm,
    dreaming: loadDreamingConfig((config as any).dreaming),
    // L2 主题档案：workspace/memory/topics/*.md，随 reindex 周期自动进检索索引
    topicStore: {
      read: async (name: string) => {
        try {
          return await fs.readFile(path.join(memoryDir, "topics", name), "utf-8");
        } catch {
          return null;
        }
      },
      write: async (name: string, content: string) => {
        const dir = path.join(memoryDir, "topics");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, name), content, "utf-8");
      },
    },
    llmGenerate: async (prompt: string) =>
      (
        await llm.generate({
          model: config.defaultModel,
          messages: [{ role: "user" as const, content: prompt }],
        })
      ).content,
    readMemory: () => memory.readMemory(),
    writeMemory: (content: string) => memory.writeMemory(content),
    maskSecret: maskSecrets,
  };
  let dreamBusy = false;
  async function runDreamingCycle() {
    if (dreamBusy) throw new Error("上一次梦境仍在运行中");
    dreamBusy = true;
    try {
      const light = await lightDreaming(dreamDeps);
      const rem = await remDreaming(dreamDeps);
      const deep = await deepDreaming(dreamDeps);
      return { light, rem, deep };
    } finally {
      dreamBusy = false;
    }
  }

  // 密钥屏蔽：.env 值进入对话历史/模型上下文前统一替换 ***
  initSecretMask(config.stateDir);

  // cron / 事件 watcher：watch 命中前静默检查（零 LLM 成本），命中才执行 payload
  const cron = new CronManager();
  const runCronTurn = async (text: string, name: string) => {
    const agent = agents["default"] ?? Object.values(agents)[0];
    const s = sessions.create({
      agentId: agent?.name ?? "default",
      model: agent?.model,
      title: `[cron] ${name}`.slice(0, 50),
      systemPrompt: agent
        ? await agent.memory.buildSystemPrompt()
        : undefined,
    });
    await sessions.run(s.id, text, { toolRegistry: tools });
  };
  const cronScheduler = new CronScheduler(cron, async (job) => {
    if (job.schedule.kind === "watch") {
      const hit = cron.runWatchCheck(job.schedule);
      if (!hit?.fire) return; // 静默：未命中不产生任何 LLM 调用
      await runCronTurn(
        `⚡ 事件 watcher "${job.name}" 命中${hit.message ? `：${hit.message}` : ""}\n${job.payload.message ?? ""}`.trim(),
        job.name,
      );
      return;
    }
    if (job.payload.kind === "script" && job.payload.script) {
      execSync(job.payload.script, {
        timeout: 30000,
        maxBuffer: 64 * 1024,
      });
      return;
    }
    if (job.payload.kind === "agentTurn" && job.payload.message) {
      await runCronTurn(job.payload.message, job.name);
    }
  });
  cronScheduler.start();

  // 会话持久化恢复：重启/崩溃时未消费的排队消息自动续跑（不开新会话）
  setTimeout(() => {
    // 先扫描被中断的轮次（active_turns 残留行），注入续跑消息入队
    const n = sessions.recoverInterruptedTurns();
    if (n > 0) console.log(`♻️ 发现 ${n} 个被重启中断的任务，已入队续跑`);
    const sids = db
      .prepare("SELECT DISTINCT session_id FROM pending_queue")
      .all() as any[];
    for (const { session_id: ssid } of sids) {
      const sess = sessions.get(ssid);
      if (!sess) {
        db.prepare("DELETE FROM pending_queue WHERE session_id = ?").run(ssid);
        continue;
      }
      if (sessions.isBusy(ssid)) continue;
      const ag = agents[sess.agentId] ?? agents["default"];
      const n = (
        db
          .prepare(
            "SELECT COUNT(*) c FROM pending_queue WHERE session_id = ?",
          )
          .get(ssid) as any
      ).c;
      console.log(`♻️ 恢复会话 ${ssid.slice(0, 8)} 的 ${n} 条排队消息`);
      sessions
        .run(ssid, null, {
          toolRegistry: tools,
          workDir: ag?.workspaceDir,
          thinking: ag?.thinking as any,
        })
        .catch((e: any) =>
          console.warn("♻️ 恢复失败:", String(e?.message).slice(0, 120)),
        );
    }
  }, 1500);

  // 备份自动化：每日 VACUUM INTO 快照 + 各工作区记忆文件；设置页可开关/调间隔/调保留数
  const backup = new BackupManager(
    path.join(config.stateDir, "backups"),
    10,
    Object.values(agents)
      .map((a: any) => [
        { label: `MEMORY.${a.name}`, path: path.join(a.workspaceDir, "MEMORY.md") },
        { label: `USER.${a.name}`, path: path.join(a.workspaceDir, "USER.md") },
      ])
      .flat(),
  );
  setInterval(async () => {
    try {
      const st = loadSettings(config.stateDir);
      if (!st.backup.enabled) return;
      const list = await backup.list();
      const latest = list[0]?.createdAt ?? 0;
      if (Date.now() - latest < st.backup.intervalHours * 3600000) return;
      const info = await backup.backup({ keep: st.backup.keep });
      console.log(`💾 自动备份完成: ${info.name} (${(info.size / 1024).toFixed(0)}KB)`);
    } catch (e: any) {
      console.warn("💾 备份失败:", String(e?.message).slice(0, 140));
    }
  }, 60000);

  const app = createApp({
    llm,
    sessions,
    tools,
    searcher,
    memory,
    config,
    agents,
    embedding,
    runDreaming: runDreamingCycle,
    cron,
    backup,
    // 检索管道 introspection（Web UI 检索拓扑图）：每次请求现取，热配置变更即时反映
    getRetrievalStats: () => {
      const counts = db
        .prepare("SELECT source, COUNT(*) c, COUNT(DISTINCT file_path) f FROM memory_entries GROUP BY source")
        .all() as any[];
      const st = (p: string) =>
        (db.prepare("SELECT last_run_at FROM dreaming_state WHERE phase=?").get(p) as any)?.last_run_at ?? 0;
      const sm = (col: string) =>
        (db.prepare(`SELECT COUNT(*) c FROM short_term_memory WHERE ${col}`).get() as any).c;
      let fingerprint = "";
      try {
        fingerprint = String((db.prepare("SELECT value FROM meta WHERE key='embedding_fingerprint'").get() as any)?.value ?? "");
      } catch {}
      return {
        embedding: {
          provider: embCfg.provider ?? "simple",
          model: embCfg.model ?? (embCfg.provider === "ollama" ? "nomic-embed-text" : "-"),
          fingerprint,
        },
        rerankCfg: msCfg.rerank ?? { mmr: true, lambda: 0.7, halfLifeDays: 0 },
        hybridCfg: msCfg.hybrid ?? { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
        channels: {
          fts: { available: memIndex.fts.ok, rows: (db.prepare("SELECT COUNT(*) c FROM memory_fts").get() as any).c },
          vec: {
            extension: memIndex.vec.available, // sqlite-vec .so 是否加载成功
            accelerated: memIndex.vec.ready, // vec0 KNN 在用（否则 BLOB 暴力扫兜底）
            dims: memIndex.vec.dims,
            rows: (db.prepare("SELECT COUNT(*) c FROM memory_vec").get() as any).c,
          },
        },
        entries: counts.map((r) => ({ source: r.source, chunks: r.c, files: r.f })),
        reindexIntervalMinutes: msCfg.reindexIntervalMinutes ?? 10,
        shortTerm: {
          active: sm("promoted_at IS NULL AND forgotten_at IS NULL AND dormant_at IS NULL"),
          promoted: sm("promoted_at IS NOT NULL"),
          forgotten: sm("forgotten_at IS NOT NULL"),
          dormant: sm("dormant_at IS NOT NULL"),
        },
        dreaming: { lightAt: st("light"), remAt: st("rem"), deepAt: st("deep") },
        memoryMdBytes: (() => { try { return statSync(path.join(workspaceDir, "MEMORY.md")).size; } catch { return 0; } })(),
      };
    },
  });

  // 梦境调度：每分钟查 settings.json；上次运行时间从 dreaming_state 读（重启不丢）
  setInterval(async () => {
    try {
      const st = loadSettings(config.stateDir);
      if (!st.dreaming.enabled || dreamBusy) return;
      const row = db
        .prepare("SELECT MAX(last_run_at) AS t FROM dreaming_state")
        .get() as any;
      if (
        Date.now() - Number(row?.t ?? 0) <
        st.dreaming.intervalMinutes * 60000
      )
        return;
      await runDreamingCycle();
      console.log("🌙 梦境巩固完成");
    } catch (e: any) {
      console.warn("🌙 梦境失败:", String(e?.message).slice(0, 140));
    }
  }, 60000);
  const port = Number(process.env.PORT ?? 4096);
  if (await portInUse(port)) {
    console.error(
      `❌ 端口 ${port} 已被占用 — 网关很可能已在运行（systemd 服务默认自启）。\n` +
        `   确认: curl http://localhost:${port}/health\n` +
        `   要手动跑先停服务: systemctl --user stop easy-agent-gateway`,
    );
    process.exit(1);
  }

  serve({ fetch: app.fetch, port });
  console.log(`Gateway: http://localhost:${port}`);
}

main();
