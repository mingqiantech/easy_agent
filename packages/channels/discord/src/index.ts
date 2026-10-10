import { ChannelManager } from "@easy-agent/core/channel/manager";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { getDatabase } from "@easy-agent/core/database";
import { loadConfig } from "@easy-agent/config/loader";
import { DiscordAdapter } from "./bot.js";

async function main() {
  const config = loadConfig();
  getDatabase();

  const llm = new LLMClient({ providers: config.providers });
  const sessions = new SessionManager(llm, {
    defaultModel: config.defaultModel,
  });
  const tools = new ToolRegistry(true);

  const channels = new ChannelManager(
    sessions,
    tools,
    config.defaultModel,
    process.cwd(),
  );

  channels.register(
    new DiscordAdapter({
      botToken: config.discord.botToken,
      applicationId: config.discord.applicationId,
      allowedUserIds: process.env.DISCORD_ALLOWED_USERS?.split(","),
    }),
  );

  await channels.startAll();
}

main().catch(console.error);
