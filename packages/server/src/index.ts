import { serve } from "@hono/node-server";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "./app.js";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";
import { MemorySearcher } from "@easy-agent/memory/search";
import { ShortTermMemory } from "@easy-agent/memory/short-term";
import { createMemorySearchTool } from "@easy-agent/memory/tool";
import { createWebsearchTool } from "@easy-agent/core/tool/builtins/websearch";
import { SubAgentManager } from "@easy-agent/core/agent/sub-agent";
import { createSubAgentTool } from "@easy-agent/core/agent/sub-agent-tool";
import { createVisionTool } from "@easy-agent/core/tool/builtins/vision";
import { ImageGenerator } from "@easy-agent/core/image-gen/index";
import { createImageGenTool } from "@easy-agent/core/tool/builtins/image-gen";
import { MonitoringSystem } from "@easy-agent/core/monitoring/index";

import { loadConfig } from "@easy-agent/config/loader";
import { modelFallbackMap, resolveImageGenModelId, resolveAgents } from "@easy-agent/config/models";
import { loadSettings } from "./settings.js";
import {
  lightDreaming,
  remDreaming,
  deepDreaming,
} from "@easy-agent/memory/dreaming";
import { getDatabase } from "@easy-agent/core/database";
import { CronManager } from "@easy-agent/core/cron/index";
import { CronScheduler } from "@easy-agent/core/cron/scheduler";
import { initSecretMask } from "@easy-agent/core/secrets-mask";
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

  // memory_search 注册进工具表，agent 对话可用
  tools.register(createMemorySearchTool(searcher));

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
      memory: mem,
    };
  }
  console.log(`🤖 Agents: ${Object.keys(agents).join(", ")}`);

  // 梦境（Dreaming）：浅眠→REM→深眠，短期记忆提炼晋升；设置页与调度器共用
  const dreamDeps = {
    db,
    shortTerm,
    llmGenerate: async (prompt: string) =>
      (
        await llm.generate({
          model: config.defaultModel,
          messages: [{ role: "user" as const, content: prompt }],
        })
      ).content,
    readMemory: () => memory.readMemory(),
    writeMemory: (content: string) => memory.writeMemory(content),
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

  const app = createApp({
    llm,
    sessions,
    tools,
    searcher,
    memory,
    config,
    agents,
    runDreaming: runDreamingCycle,
    cron,
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
