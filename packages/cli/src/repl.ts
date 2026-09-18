import * as readline from "node:readline";
import type { SessionManager } from "@easy-agent/core/session";
import type { Config } from "@easy-agent/config/schema";

export async function startRepl(
  sessions: SessionManager,
  config: Config,
): Promise<void> {
  const session = sessions.create({
    model: config.defaultModel,
    systemPrompt: buildSystemPrompt(),
  });
  console.log(`   Session: ${session.id}`);
  console.log("");
  console.log("   命令: /sessions — 列出会话");
  console.log("         /new      — 新建会话");
  console.log("         /model    — 切换模型");
  console.log("         /exit     — 退出");
  console.log("");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let currentSeesionId = session.id;
  const prompt = (): void => {
    rl.question("\n> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, sessions, rl);
        prompt();
        return;
      }

      try {
        process.stdout.write("\n");
        const response = await sessions.run(currentSeesionId, trimmed);
        console.log(`\n${response}`);
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
