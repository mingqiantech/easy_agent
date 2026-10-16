import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { getDatabase } from "@easy-agent/core/database";
import { loadConfig } from "@easy-agent/config/loader";
import { TelegramBot } from "./bot.js";

async function main() {
  const config = loadConfig();
  getDatabase();

  const llm = new LLMClient({ providers: config.providers });
  const sessions = new SessionManager(llm, {
    defaultModel: config.defaultModel,
  });
  const tools = new ToolRegistry(true);

  const bot = new TelegramBot(
    {
      botToken: process.env.TG_BOT_TOKEN || config.telegram?.botToken || "",
      defaultModel: config.defaultModel,
      allowedUserIds: process.env.TG_ALLOWED_USERS
        ? process.env.TG_ALLOWED_USERS.split(",").map(Number)
        : config.telegram?.allowedUserIds,
      workDir: process.cwd(),
    },
    sessions,
    tools,
  );
  await bot.start();
}

main().catch(console.error);
