import * as readlinw from "node:readline";
import type { SessionManager } from "@easy-agent/core/session";
import type { ToolRegistry } from "@easy-agent/core/tool/registry";
import { runStream } from "@easy-agent/core/session-stream";

export async function startStreamRepl(
  sessions: SessionManager,
  toolRegistry: ToolRegistry,
  config: any,
): Promise<void> {
  const workDir = process.cwd();
  const session = sessions.create({ model: config.defaultModel });

  console.log(`\n🤖 Easy Agent v0.5.0 (stream)`);
  console.log(`   Model: ${config.defaultModel}`);
  console.log(`   Session: ${session.id.slice(0, 12)}...\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question("\n> ", async (input) => {
      const t = input.trim();
      if (!t) {
        prompt();
        return;
      }
      if (t === "/exit") {
        process.exit(0);
      }

      try {
        process.stdout.write("\n");
        await runStream(sessions, session.id, t, {
          toolRegistry,
          workDir,
          onText: (text) => process.stdout.write(text),
          onToolCall: (name, input) => {
            process.stdout.write(`\n🔧 ${name} ${JSON.stringify(input)}`);
          },
          onToolResult: (name, result) => {
            const s =
              typeof result === "string" ? result : JSON.stringify(result);
            process.stdout.write(
              `\n   → ${s.length > 200 ? s.slice(0, 200) + "..." : s}\n`,
            );
          },
          onUsage: (u) => console.log(`\n   [tokens: ${u.totalTokens}]`),
          onDone: () => {},
          onError: (e) => console.error(`\n❌ ${e}`),
        });
      } catch (e: any) {
        console.error(`\n❌ ${e.message}`);
      }
    });
  };

  rl.on("close", () => {
    console.log("\nBye! 👋");
    process.exit(0);
  });
  prompt();
}
