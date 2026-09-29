import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";
import { MemorySearcher } from "@easy-agent/memory/search";
import { loadConfig } from "@easy-agent/config/loader";
import { getDatabase } from "@easy-agent/core/database";
import { memoryGetTool } from "../../core/src/tool/builtins/memory-get.js";

async function main() {
  const config = loadConfig();
  getDatabase();

  const llm = new LLMClient({ providers: config.providers });
  const sessions = new SessionManager(llm, {
    defaultModel: config.defaultMpdel,
  });
  const tools = new ToolRegistry();
  const memory = new BasicMemory(process.cwd());
  const searcher = new MemorySearcher(process.cwd(), `${process.cwd()}/memory`);

  const app = createApp({ llm, sessions, tools, searcher, memory, config });
  const port = Number(process.env.PORT ?? 4096);
  console.log(`Gateway: http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
}

main();
