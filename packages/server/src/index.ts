import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";
import { MemorySearcher } from "@easy-agent/memory/search";
import { ShortTermMemory } from "@easy-agent/memory/short-term";
import { createMemorySearchTool } from "@easy-agent/memory/tool";
import { SubAgentManager } from "@easy-agent/core/agent/sub-agent";
import { createSubAgentTool } from "@easy-agent/core/agent/sub-agent-tool";
import { createVisionTool } from "@easy-agent/core/tool/builtins/vision";
import { ImageGenerator } from "@easy-agent/core/image-gen/index";
import { createImageGenTool } from "@easy-agent/core/tool/builtins/image-gen";
import { MonitoringSystem } from "@easy-agent/core/monitoring/index";

import { loadConfig } from "@easy-agent/config/loader";
import { getDatabase } from "@easy-agent/core/database";

async function main() {
  const config = loadConfig();
  const db = getDatabase();

  const llm = new LLMClient({ providers: config.providers });
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

  // Week5 Step 3：子 Agent 工具
  const subAgents = new SubAgentManager(
    sessions,
    tools,
    llm,
    config.defaultModel,
  );
  tools.register(createSubAgentTool(subAgents));

  // Week6: Vision 工具（图片理解）
  tools.register(createVisionTool(config.visionModel ?? config.defaultModel));

  // Week8: 图片生成工具
  tools.register(
    createImageGenTool(
      new ImageGenerator({ baseUrl: config.providers.openai?.baseUrl }),
    ),
  );

  // Week8: 监控告警（默认规则：库过大/错误率飙升）
  const monitoring = new MonitoringSystem();
  monitoring.addDefaultRules(async (msg) => console.error(msg));
  monitoring.start(60000);

  const app = createApp({
    llm,
    sessions,
    tools,
    searcher,
    memory,
    config,
  });
  const port = Number(process.env.PORT ?? 4096);
  try {
    serve({ fetch: app.fetch, port });
    console.log(`Gateway: http://localhost:${port}`);
  } catch (e: any) {
    if (e?.code === "EADDRINUSE") {
      console.error(
        `❌ 端口 ${port} 已被占用 — 网关很可能已在运行（systemd 服务默认自启）。\n` +
          `   确认: curl http://localhost:${port}/health\n` +
          `   要手动跑先停服务: systemctl --user stop easy-agent-gateway`,
      );
      process.exit(1);
    }
    throw e;
  }
}

main();
