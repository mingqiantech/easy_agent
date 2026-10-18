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
import { PluginRegistry } from "@easy-agent/core/plugin/registry";
import { modelChain, resolveImageGenModelId, resolveAgents } from "@easy-agent/config/models";
import path from "node:path";

export async function startRepl(
  sessions: SessionManager,
  config: Config,
  llm: LLMClient,
): Promise<void> {
  const workDir = config.workspaceDir || process.cwd();
  const memory = new BasicMemory(workDir);
  await memory.ensureMemoryFile();
  const fresh = await memory.initWorkspace();
  if (fresh.length > 0) {
    console.log(`📦 工作区初始化: ${workDir} (+${fresh.join(", ")})`);
  }

  // 本 REPL 以 default agent 身份运行，思考等级跟随配置
  const selfAgent = resolveAgents(config).find((a) => a.name === "default")!;

  const toolRegistry = new ToolRegistry(true);

  // Week8: 插件市场
  const pluginRegistry = new PluginRegistry(path.join(workDir, "plugins"));
  await pluginRegistry.scan();

  // Week5 Step 3：子 Agent 注册为工具
  const subAgents = new SubAgentManager(
    sessions,
    toolRegistry,
    llm,
    config.defaultModel,
  );
  toolRegistry.register(
    createSubAgentTool(subAgents, () => ({
      default: { model: selfAgent.model, workspaceDir: workDir, memory },
    })),
  );

  // Week6: Vision 工具（图片理解）
  toolRegistry.register(
    createVisionTool(config.visionModel ?? config.defaultModel),
  );

  // Week8: 图片生成工具
  toolRegistry.register(
    createImageGenTool(
      new ImageGenerator({
        baseUrl: config.providers.openai?.baseUrl,
        model: resolveImageGenModelId(config),
      }),
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
  console.log(`   /tools /memory /sessions /plugins /model /exit\n`);

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
        const [cmd, ...rest] = t.slice(1).split(" ");
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
        else if (cmd === "plugins") {
          const sub = rest[0] ?? "list";
          try {
            if (sub === "list") {
              const l = await pluginRegistry.scan();
              console.log(
                l.length
                  ? l
                      .map(
                        (p) =>
                          `  ${p.enabled ? "✓" : "✗"} ${p.name} v${p.version}${p.description ? " — " + p.description : ""}`,
                      )
                      .join("\n")
                  : "  (无插件：将插件放入 plugins/<name>/ 目录)",
              );
            } else if (sub === "enable" && rest[1]) {
              await pluginRegistry.enable(rest[1]);
              console.log(`  ✓ Enabled: ${rest[1]}`);
            } else if (sub === "disable" && rest[1]) {
              await pluginRegistry.disable(rest[1]);
              console.log(`  ✗ Disabled: ${rest[1]}`);
            } else if (sub === "install" && rest[1]) {
              await pluginRegistry.install(rest[1]);
              console.log(`  ✓ Installed: ${rest[1]}`);
            } else if (sub === "uninstall" && rest[1]) {
              await pluginRegistry.uninstall(rest[1]);
              console.log(`  ✗ Uninstalled: ${rest[1]}`);
            } else {
              console.log("  /plugins list|enable <n>|disable <n>|install <pkg>|uninstall <n>");
            }
          } catch (e: any) {
            console.log(`  ❌ ${e.message}`);
          }
        } else if (cmd === "model") {
          const chain = modelChain(config);
          console.log(`  primary: ${chain[0]}`);
          console.log(`  thinking: ${selfAgent.thinking}`);
          if (chain.length > 1)
            console.log(`  fallbacks: ${chain.slice(1).join(" → ")}`);
          const catalog = Object.entries(config.models ?? {});
          if (catalog.length > 0) {
            console.log("  catalog:");
            for (const [ref, e] of catalog)
              console.log(`    ${e.alias ? e.alias + " → " : ""}${ref}`);
          }
        } else console.log("  /tools /memory /sessions /plugins /model /exit");

        prompt();
        return;
      }

      busy = true;
      try {
        const response = await sessions.run(sid, t, {
          toolRegistry,
          workDir,
          thinking: selfAgent.thinking,
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
      busy = false;
      if (closing) {
        bye();
        return;
      }
      prompt();
    });
  };

  // 退出排空：stdin 关闭（Ctrl+D / 管道 EOF）时若仍在处理，等当前回复完成再退出
  const bye = (): void => {
    console.log("\nBye! 👋");
    process.exit(0);
  };
  let closing = false;
  let busy = false;
  rl.on("close", () => {
    closing = true;
    if (!busy) bye();
  });
  prompt();
}

