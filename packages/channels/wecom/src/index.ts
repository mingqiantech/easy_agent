import { ChannelManager } from "@easy-agent/core/channel/manager";
import { LLMClient } from "@easy-agent/llm/client";
import { SessionManager } from "@easy-agent/core/session";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { getDatabase } from "@easy-agent/core/database";
import { loadConfig } from "@easy-agent/config/loader";
import { modelFallbackMap } from "@easy-agent/config/models";
import { WeComAdapter } from "./bot.js";

async function main() {
  const config = loadConfig();
  getDatabase();

  if (!config.wecom?.botId || !config.wecom?.secret) {
    console.error(
      "❌ wecom 未配置：请在 ~/.easy-agent/easy-agent.json 填写 wecom.botId / wecom.secret",
    );
    process.exit(1);
  }

  const llm = new LLMClient({
    providers: config.providers,
    fallbacks: modelFallbackMap(config),
  });
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
    new WeComAdapter({
      botId: config.wecom.botId,
      secret: config.wecom.secret,
      allowedUserIds:
        process.env.WECOM_ALLOWED_USERS?.split(",").filter(Boolean) ??
        config.wecom.allowedUserIds,
    }),
  );

  await channels.startAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
