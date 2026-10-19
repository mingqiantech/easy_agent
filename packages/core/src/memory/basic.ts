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

  async writeMemory(content: string): Promise<void> {
    await fs.writeFile(path.join(this.workDir, "MEMORY.md"), content, "utf-8");
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

  /**
   * 初始化工作区（OpenClaw 风格）：首次启动时生成模板文件。
   * 已存在的文件不覆盖。
   */
  async initWorkspace(): Promise<string[]> {
    const created: string[] = [];
    // 目录不存在先建（agent 独立工作区首次启动时 writeFile 需要父目录）
    await fs.mkdir(this.workDir, { recursive: true });

    const templates: Record<string, string> = {
      "MEMORY.md": "# Long-Term Memory\n\n_No memories yet._\n",
      "USER.md":
        "# USER.md - About Your Human\n\n- **Name:**\n- **Timezone:**\n- **Language:**\n\n## Context\n\n_(慢慢了如指掌)_\n",
      "AGENTS.md":
        "# AGENTS.md - Workspace Instructions\n\n## Memory\n\n- 每天记 `memory/YYYY-MM-DD.md`；重要决策写入 MEMORY.md\n- 想记住的事 → 写文件，不要只记在脑子里\n\n## Red Lines\n\n- 不外泄私人数据\n- 破坏性命令先问\n",
      "SOUL.md":
        "# SOUL.md - 性格与价值观（对内）\n\n- 说话直接，先结果后过程\n- 不确定就说不确定，不装懂\n- 能直接办的别反问；确有歧义才问，一次问清\n\n_(这份文件可以随自我认知进化而改写)_\n",
      "IDENTITY.md":
        "# IDENTITY.md - 身份设定（对外）\n\n- **Name:** easy-agent\n- **Role:** 本地 AI 助手\n- **Style:** 轻快、简洁\n\n_(相当于岗位说明书；改名/改定位从这里开始)_\n",
      "BOOTSTRAP.md":
        "# BOOTSTRAP.md - 首次启动引导\n\n你是新初始化的 agent。按顺序完成：\n\n1. 读 IDENTITY.md / SOUL.md / USER.md，认识自己和服务对象\n2. 用 write 工具把 IDENTITY.md 的 Name 改成用户给你的名字（没给就问一次）\n3. 往 MEMORY.md 记一条：何时、为谁、因何创建\n4. 处理完后用 bash 工具删除本文件：rm BOOTSTRAP.md\n\n完成后简短打招呼，开始工作。\n",
    };

    for (const [name, content] of Object.entries(templates)) {
      const p = path.join(this.workDir, name);
      try {
        await fs.access(p);
      } catch {
        await fs.writeFile(p, content, "utf-8");
        created.push(name);
      }
    }

    await fs.mkdir(path.join(this.workDir, "memory"), { recursive: true });
    return created;
  }

  /**
   * 每轮 system prompt 组装（固定顺序，缺文件跳过）：
   * IDENTITY → SOUL → AGENTS → USER → MEMORY → 当日 diary → TOOLS(截断) → BOOTSTRAP(存在时)
   */
  private async readIfExists(name: string): Promise<string> {
    try {
      return await fs.readFile(path.join(this.workDir, name), "utf-8");
    } catch {
      return "";
    }
  }

  async buildSystemPrompt(): Promise<string> {
    let prompt = `You are a helpful AI assistant with tools. Be direct and concise.
Current date: ${new Date().toISOString().slice(0, 10)}
Working directory: ${this.workDir}
Respond in the user's language.`;

    const sections: Array<[string, string, string]> = [
      ["identity", "Agent Identity (对外身份)", await this.readIfExists("IDENTITY.md")],
      ["soul", "Agent Soul (性格与价值观)", await this.readIfExists("SOUL.md")],
      ["agents", "Workspace Instructions", await this.readIfExists("AGENTS.md")],
      ["user_info", "User Profile", await this.readUser()],
    ];

    const mem = await this.readMemory();
    if (mem && !mem.includes("No memories yet"))
      sections.push(["important_context", "Long-Term Memory", mem]);

    // 当日 diary：详细但用到才查 —— 只注入今天那份，控制基线 token
    const today = new Date().toISOString().slice(0, 10);
    const diary = await this.readIfExists(`memory/${today}.md`);
    if (diary?.trim()) sections.push(["diary_today", `Today's Diary (${today})`, diary]);

    // TOOLS.md 是自动生成的清单，模型也能用 tool 列表看到；只取前 2000 字符防重叠膨胀
    const toolsMd = await this.readIfExists("TOOLS.md");
    if (toolsMd?.trim())
      sections.push(["tools", "Workspace Tools Notes", toolsMd.slice(0, 2000)]);

    // BOOTSTRAP.md 存在 = 首次引导；agent 处理完应自行删除
    const bootstrap = await this.readIfExists("BOOTSTRAP.md");
    if (bootstrap?.trim())
      sections.push(["bootstrap", "FIRST-RUN BOOTSTRAP (完成引导后删除本文件)", bootstrap]);

    for (const [tag, title, body] of sections) {
      if (!body?.trim()) continue;
      prompt += `\n\n<${tag}>\n## ${title}\n${body}\n</${tag}>`;
    }

    return prompt;
  }
}
