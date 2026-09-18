import { LLMClient } from "@easy-agent/llm/client";
import { SessionInfo } from "@easy-agent/core/session";
import { closeDatabase } from "@easy-agent/core/database";
import { loadConfig } from "@easy-agent/config/loader";
import { startRepl } from "./repl.js";
import { SessionManager } from "../../core/src";

async function main() {
  const config = loadConfig();
  const providerNames = Object.keys(config.providers);
  if (providerNames.length === 0) {
    console.error("❌ No API keys configured.");
    console.error("");
    console.error("Set at least one of these environment variables:");
    console.error("  export OPENAI_API_KEY='sk-...'");
    console.error("  export ANTHROPIC_API_KEY='sk-ant-...'");
    console.error("");
    console.error("Or create a config file: easy-agent.json");
    process.exit(1);
  }

  const llm = new LLMClient({ providers: config.providers });
  const sessions = new SessionManager(llm, {
    defaultModel: config.defaultModel,
  });
  console.log("");
  console.log("🤖 My Agent v0.1.0");
  console.log(`   Model: ${config.defaultModel}`);
  console.log(`   Providers: ${providerNames.join(", ")}`);
  console.log("");

  await startRepl(sessions, config);

  closeDatabase();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
