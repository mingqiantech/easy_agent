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

    case "memory": {
      const subcmd = args[0];
      if (subcmd === "status") {
        const mem = await memory.readMemory();
        const stCount = shortTerm.count();
        console.log(
          `  MEMORY.md: ${mem.length} chars (${(mem.length / 1024).toFixed(1)}KB)`,
        );
        console.log(`  Short-term: ${stCount} entries`);
        console.log(
          `  Daily files: ${(await fs.readdir(memoryDir)).filter((f) => f.endsWith(".md")).length}`,
        );
      } else if (subcmd === "search") {
        const q = args.slice(1).join(" ");
        if (!q) {
          console.log("  Usage: /memory search <query>");
          break;
        }
        const result = await searcher.search(q);
        for (const hit of result.hits) {
          console.log(
            `  [${hit.score.toFixed(2)}] ${hit.path}: ${hit.excerpt.slice(0, 80)}`,
          );
        }
      } else {
        console.log((await memory.readMemory()) || "(empty)");
      }
      break;
    }

    // /dreaming — 手动触发巩固
    case "dreaming": {
      console.log("  Running light dreaming...");
      const l = await lightDreaming(dreamingDeps);
      console.log(
        `  Light: processed ${l.processed}, extracted ${l.extracted}`,
      );
      console.log("  Running REM dreaming...");
      const r = await remDreaming(dreamingDeps);
      console.log(`  REM: ${r.candidates} candidates`);
      console.log("  Running deep dreaming...");
      const d = await deepDreaming(dreamingDeps);
      console.log(`  Deep: promoted ${d.promoted}, forgotten ${d.forgotten}`);
      break;
    }

    // /cron list — 列出定时任务
    case "cron": {
      const jobs = cronManager.list();
      if (jobs.length === 0) {
        console.log("  No cron jobs");
        break;
      }
      for (const j of jobs) {
        const lastRun = j.lastRunAt
          ? new Date(j.lastRunAt).toLocaleString("zh-CN")
          : "never";
        console.log(
          `  ${j.name} (${j.schedule.kind}) — last: ${lastRun}, runs: ${j.runCount}`,
        );
      }
      break;
    }

    // /tools — 列出工具
    case "tools": {
      for (const t of toolRegistry.list())
        console.log(`  ${t.name}: ${t.description.split("\n")[0]}`);
      break;
    }

    // /config — 配置管理
    case "config": {
      if (args[0] === "get" && args[1]) {
        console.log(
          `  ${args[1]} = ${(config as any)[args[1]] ?? "(not set)"}`,
        );
      } else if (args[0] === "set" && args[1] && args[2]) {
        console.log(`  Set ${args[1]} = ${args[2]} (restart required)`);
      } else {
        console.log(`  model: ${config.defaultModel}`);
        console.log(`  providers: ${Object.keys(config.providers).join(", ")}`);
      }
      break;
    }
    // /model — 切换模型
    case "model": {
      if (args[0]) {
        console.log(`  Model switched to: ${args[0]} (next session)`);
        // TODO: 实际切换
      } else {
        console.log(`  Current: ${config.defaultModel}`);
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
