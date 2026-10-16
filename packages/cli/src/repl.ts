import * as readline from "node:readline";
import type { SessionManager } from "@easy-agent/core/session";
import type { Config } from "@easy-agent/config/schema";
import type { LLMClient } from "@easy-agent/llm/client";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";
import { SubAgentManager } from "@easy-agent/core/agent/sub-agent";
import { createSubAgentTool } from "@easy-agent/core/agent/sub-agent-tool";
import { createVisionTool } from "@easy-agent/core/tool/builtins/vision";
import { ImageGenerator } from "@easy-agent/core/image-gen/index";
import { createImageGenTool } from "@easy-agent/core/tool/builtins/image-gen";

export async function startRepl(
  sessions: SessionManager,
  config: Config,
  llm: LLMClient,
): Promise<void> {
  const workDir = process.cwd();
  const memory = new BasicMemory(workDir);
  await memory.ensureMemoryFile();

  const toolRegistry = new ToolRegistry(true);

  // Week5 Step 3：子 Agent 注册为工具
  const subAgents = new SubAgentManager(
    sessions,
    toolRegistry,
    llm,
    config.defaultModel,
  );
  toolRegistry.register(createSubAgentTool(subAgents));

  // Week6: Vision 工具（图片理解）
  toolRegistry.register(
    createVisionTool(config.visionModel ?? config.defaultModel),
  );

  // Week8: 图片生成工具
  toolRegistry.register(
    createImageGenTool(
      new ImageGenerator({ baseUrl: config.providers.openai?.baseUrl }),
    ),
  );
  const session = sessions.create({
    model: config.defaultModel,
    systemPrompt: await memory.buildSystemPrompt(),
  });
  const memSize = (await memory.readMemory()).length;

  console.log(`\n🤖 My Agent v0.2.0`);
  console.log(`   Model: ${config.defaultModel}`);
  console.log(
    `   Memory: ${memSize > 0 ? `${(memSize / 1024).toFixed(1)}KB` : "empty"}`,
  );
  console.log(`   Tools: ${toolRegistry.names().join(", ")}`);
  console.log(`   /tools /memory /sessions /exit\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let sid = session.id;

  const prompt = (): void => {
    rl.question("\n> ", async (input) => {
      const t = input.trim();
      if (!t) {
        prompt();
        return;
      }

      if (t.startsWith("/")) {
        const cmd = t.slice(1).split(" ")[0];
        if (cmd === "exit" || cmd === "q") {
          console.log("Bye!");
          process.exit(0);
        } else if (cmd === "tools")
          toolRegistry
            .list()
            .forEach((t) =>
              console.log(` ${t.name}: ${t.description.split("\n")[0]}`),
            );
        else if (cmd === "memory")
          console.log((await memory.readMemory()) || "(empty)");
        else if (cmd === "sessions")
          sessions
            .list(20)
            .forEach((s) =>
              console.log(
                `  ${s.id.slice(0, 8)} | ${s.title ?? "untitled"} | ${s.messageCount} msgs`,
              ),
            );
        else console.log("  /tool /memory /sessions /exit");

        prompt();
        return;
      }

      try {
        const response = await sessions.run(sid, t, {
          toolRegistry,
          workDir,
          onToolCall: (name, input) =>
            console.log(`\n🔧 ${name} ${JSON.stringify(input)}`),
          onToolResult: (name, result) => {
            const s =
              typeof result === "string" ? result : JSON.stringify(result);
            console.log(`   → ${s.length > 200 ? s.slice(0, 200) + "..." : s}`);
          },
        });
        console.log(`\n${response}`);
        await memory.appendDaily(`Q: ${t.slice(0, 80)}`);
      } catch (error: any) {
        console.error(`\n❌ Error: ${error.message}`);
      }
      prompt();
    });
  };
  rl.on("close", () => {
    console.log("\nBye! 👋");
    process.exit(0);
  });
  prompt();
}

