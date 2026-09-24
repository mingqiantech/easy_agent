import fs from "node:fs/promises";
import path from "node:path";

export class BasicMemory {
  constructor(private workDir: string) {}

  async readMemory(): Promise<string> {
    try {
      return await fs.readFile(path.join(this.workDir, "MEMORY.md"), "utf-8");
    } catch {
      return "";
    }
  }

  async readUser(): Promise<string> {
    try {
      return await fs.readFile(path.join(this.workDir, "USER.md"), "utf-8");
    } catch {
      return "";
    }
  }

  async appendDaily(entry: string): Promise<void> {
    const dir = path.join(this.workDir, "memory");
    await fs.mkdir(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `${today}.md`);
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    try {
      await fs.appendFile(file, `\n-${time} ${entry}`, "utf-8");
    } catch {
      await fs.writeFile(file, `# ${today}\n\n- ${time} ${entry}`, "utf-8");
    }
  }

  async ensureMemoryFile(): Promise<void> {
    const p = path.join(this.workDir, "MEMORY.md");
    try {
      await fs.access(p);
    } catch {
      await fs.writeFile(
        p,
        "# Long-Term Memory\n\n_No memories yet._\n",
        "utf-8",
      );
    }
  }

  async buildSystemPrompt(): Promise<string> {
    let prompt = `You are a helpful AI assistant with tools. Be direct and concise.
Current date: ${new Date().toISOString().slice(0, 10)}
Working directory: ${this.workDir}
Respond in the user's language.`;

    const mem = await this.readMemory();
    if (mem && !mem.includes("No memories yet"))
      prompt += `\n\n<important_context>\n${mem}\n</important_context>`;

    const user = await this.readUser();
    if (user?.trim()) prompt += `\n\n<user_info>\n${user}\n</user_info>`;
    return prompt;
  }
}
