import * as readline from "node:readline";
import type { SessionManager } from "@easy-agent/core/session";
import type { Config } from "@easy-agent/config/schema";
import { ToolRegistry } from "@easy-agent/core/tool/registry";
import { BasicMemory } from "@easy-agent/core/memory/basic";

export async function startRepl(
  sessions: SessionManager,
  config: Config,
): Promise<void> {
  const workDir = process.cwd();
  const memory = new BasicMemory(workDir);
  await memory.ensureMemoryFile();

  const toolRegistry = new ToolRegistry(true);
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
          session
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

async function handleCommand(
  input: string,
  sessions: SessionManager,
  rl: readline.Interface,
): Promise<void> {
  const [cmd, ...args] = input.slice(1).split(" ");
  switch (cmd) {
    case "exit":
    case "quit":
    case "q":
      console.log("Bye! 👋");
      process.exit(0);
      break;
    case "sessions":
    case "ls": {
      const list = sessions.list(20);
      if (list.length === 0) {
        console.log("  (no sessions)");
      } else {
        for (const s of list) {
          const time = new Date(s.updateAt).toLocaleString("zh-CN");
          console.log(
            `  ${s.id.slice(0, 8)} | ${s.title ?? "untitled"} | ${s.messageCount} msgs | ${time}`,
          );
        }
      }
      break;
    }
    case "new": {
      const newSession = sessions.create({});
      console.log(`  New session: ${newSession.id}`);
      break;
    }
    case "model": {
      if (args[0]) {
        console.log(`  Model: ${args[0]}`);
      } else {
        console.log(" Usage: /model <provider/model>");
      }
      break;
    }
    case "help":
    case "h":
      console.log("  /sessions  — 列出所有会话");
      console.log("  /new       — 新建会话");
      console.log("  /model <m> — 切换模型");
      console.log("  /exit      — 退出");
      break;
    default:
      console.log(
        `  Unknown command: /${cmd}. Type /help for available commands.`,
      );
  }
}

function buildSystemPrompt(): string {
  const date = new Date().toISOString().slice(0, 10);
  const cwd = process.cwd();
  return `You are a helpful AI assistant. Be direct, practical, and concise.

    Current date: ${date}
    Working directory: ${cwd}

    Respond in the same language the user uses. If they write in Chinese, respond in Chinese.`;
}
