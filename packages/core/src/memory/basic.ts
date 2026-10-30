import fs from "node:fs/promises";
import path from "node:path";
import { SkillManager } from "../skill/manager.js";

export class BasicMemory {
  constructor(private workDir: string) {}

  /** 发现工作区技能：<workDir>/skills/<name>/SKILL.md */
  async listSkills() {
    return new SkillManager(path.join(this.workDir, "skills")).scan();
  }

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

    // 示例技能：演示 SKILL.md 结构（仅首次，已存在不覆盖）
    const sample = path.join(this.workDir, "skills", "example", "SKILL.md");
    try {
      await fs.access(sample);
    } catch {
      await fs.mkdir(path.dirname(sample), { recursive: true });
      await fs.writeFile(
        sample,
        `---
name: example
description: 示例技能，仅演示 SKILL.md 格式（frontmatter + 正文步骤），可删除
triggers: [示例]
---

# 示例技能

1. 任务命中技能描述时，先读本文件
2. 按正文步骤执行

新建技能：复制本目录为 skills/<名字>/SKILL.md，改 frontmatter 即可（重启或新建会话生效）。
`,
        "utf-8",
      );
      created.push("skills/example/SKILL.md");
    }
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

  /**
   * 近 N 天日报里的教训段落（含「教训/复盘/真因/坑/红线」的 2~4 级标题及其正文）。
   * days 默认 7（env EASY_AGENT_LESSON_DAYS 覆盖，0=禁用）；从昨天往前数，今天全文另注入。
   * 总量上限 4000 字，按天均摊防单篇日报吃掉全部预算。
   */
  async recentLessons(todayIso: string, days?: number): Promise<string> {
    const window =
      days ?? (Number(process.env.EASY_AGENT_LESSON_DAYS ?? 7) || 0);
    if (window <= 0) return "";
    const perDayCap = Math.floor(4000 / window);
    const out: string[] = [];
    const base = Date.parse(`${todayIso}T00:00:00Z`);
    for (let i = 1; i <= window; i++) {
      const day = new Date(base - i * 86400000).toISOString().slice(0, 10);
      const md = await this.readIfExists(`memory/${day}.md`);
      if (!md?.trim()) continue;
      const lessons = extractLessonSections(md);
      if (lessons) out.push(`### [${day}]\n${lessons.slice(0, perDayCap)}`);
    }
    return out.join("\n\n");
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

    // 教训区：扫描近 N 天（默认 7）日报里带「教训/复盘/真因/坑/红线」标题的段落。
    // 背景（2026-10-30 误诊复盘）：之前只注入当日 diary，写进昨天日报的教训隔天就出不了
    // 上下文，同类故障隔天必重踩。今天那份已全文注入，这里从昨天往前数。
    const lessons = await this.recentLessons(today);
    if (lessons)
      sections.push(["recent_lessons", "Recent Lessons（近几天复盘沉淀，同类问题先对照此清单）", lessons]);

    // TOOLS.md 是自动生成的清单，模型也能用 tool 列表看到；只取前 2000 字符防重叠膨胀
    const toolsMd = await this.readIfExists("TOOLS.md");
    if (toolsMd?.trim())
      sections.push(["tools", "Workspace Tools Notes", toolsMd.slice(0, 2000)]);

    // BOOTSTRAP.md 存在 = 首次引导；agent 处理完应自行删除
    const bootstrap = await this.readIfExists("BOOTSTRAP.md");
    if (bootstrap?.trim())
      sections.push(["bootstrap", "FIRST-RUN BOOTSTRAP (完成引导后删除本文件)", bootstrap]);

    // 技能：描述常驻（只占几十 token），正文按需加载（命中才 read SKILL.md）
    const skills = await this.listSkills();
    if (skills.length) {
      const lines = skills.map(
        (s) =>
          `- **${s.name}**：${s.description || "（无描述）"}｜用法：用 read 工具读取 ${path.join(s.dir, "SKILL.md")} 后照做`,
      );
      sections.push([
        "skills",
        "Available Skills（命中描述先读 SKILL.md 再干活）",
        lines.join("\n"),
      ]);
    }

    for (const [tag, title, body] of sections) {
      if (!body?.trim()) continue;
      prompt += `\n\n<${tag}>\n## ${title}\n${body}\n</${tag}>`;
    }

    return prompt;
  }
}

const LESSON_TITLE_RE = /教训|复盘|真因|坑|红线/;

/**
 * 提取 markdown 里 2~4 级、标题含教训信号词（教训/复盘/真因/坑/红线）的小节，
 * 小节范围 = 标题行到下一个同级或更浅级标题（fence 内的 # 不算标题）。
 * 无命中返回空串。
 */
export function extractLessonSections(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const fence = /^\s*(```|~~~)/.test(lines[i]);
    if (fence) inFence = !inFence;
    const m = inFence ? null : /^(#{2,4})\s+(.*)$/.exec(lines[i]);
    if (m && LESSON_TITLE_RE.test(m[2])) {
      const level = m[1].length;
      const body = [lines[i]];
      let j = i + 1;
      let fence2 = false;
      for (; j < lines.length; j++) {
        if (/^\s*(```|~~~)/.test(lines[j])) fence2 = !fence2;
        const h = fence2 ? null : /^(#{1,4})\s+/.exec(lines[j]);
        if (h && h[1].length <= level) break;
        body.push(lines[j]);
      }
      out.push(body.join("\n").trim());
      i = j;
      continue;
    }
    i++;
  }
  return out.join("\n\n");
}
