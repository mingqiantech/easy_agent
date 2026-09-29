import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";
import { MemorySearcher } from "@easy-agent/memory/search";
import { ShortTermMemory } from "@easy-agent/memory/short-term";
import { createMemorySearchTool } from "@easy-agent/memory/tool";

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
  const memory = new BasicMemory(process.cwd());
  const memoryDir = `${process.cwd()}/memory`;
  const searcher = new MemorySearcher(process.cwd(), memoryDir);
  const shortTerm = new ShortTermMemory(db);

  // 搜索命中 -> 短期记忆 recall 统计（Dreaming 晋升依据）
  searcher.onHit = (filePath) => shortTerm.incrementRecall(filePath);

  // memory_search 注册进工具表，agent 对话可用
  tools.register(createMemorySearchTool(searcher));

  const app = createApp({
    llm,
    sessions,
    tools,
    searcher,
    memory,
    config,
  });
  const port = Number(process.env.PORT ?? 4096);
  console.log(`Gateway: http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}

main();
