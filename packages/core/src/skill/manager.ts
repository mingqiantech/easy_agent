import fs from "node:fs/promises";
import path from "node:path";

export interface Skill {
  name: string;
  version: string;
  description: string;
  /** 触发关键词 */
  triggers: string[];
  /** 需要的工具 */
  requiredTools: string[];
  /** SKILL.md 所在目录（绝对路径） */
  dir: string;
  /** 指令正文（注入给 Agent 的步骤说明） */
  instructions: string;
}

/**
 * 技能管理器（Week 11）
 *
 * 技能 = skills/<name>/SKILL.md：frontmatter(name/version/description/triggers/requiredTools) + 正文指令。
 * 用户输入命中触发词时，把对应 instructions 注入本轮上下文。
 */
export class SkillManager {
  private skills = new Map<string, Skill>();

  constructor(private skillsDir: string) {}

  async scan(): Promise<Skill[]> {
    this.skills.clear();
    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skill = await this.loadSkill(path.join(this.skillsDir, entry.name, "SKILL.md"));
        if (skill) this.skills.set(skill.name, skill);
      }
    } catch {
      // 目录不存在 → 空列表
    }
    return this.list();
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** 按触发词匹配（最长触发词优先，视为更精确） */
  match(input: string): Skill | null {
    const lower = input.toLowerCase();
    let best: Skill | null = null;
    let bestScore = 0;

    for (const skill of this.skills.values()) {
      let score = 0;
      for (const trigger of skill.triggers) {
        if (trigger && lower.includes(trigger.toLowerCase())) {
          score += trigger.length;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = skill;
      }
    }
    return best;
  }

  /** 生成注入到系统提示的技能片段 */
  buildSkillPrompt(skill: Skill): string {
    return `\n\n<skill name="${skill.name}">\n${skill.instructions}\n</skill>`;
  }

  private async loadSkill(filePath: string): Promise<Skill | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    const parsed = parseSkillFile(raw);
    if (!parsed) return null;

    return {
      name: String(parsed.frontmatter.name ?? path.basename(path.dirname(filePath))),
      version: String(parsed.frontmatter.version ?? "1.0.0"),
      description: String(parsed.frontmatter.description ?? ""),
      triggers: toStringArray(parsed.frontmatter.triggers),
      requiredTools: toStringArray(parsed.frontmatter.requiredTools),
      dir: path.dirname(filePath),
      instructions: parsed.body.trim(),
    };
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      return s
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  return [];
}

/** 解析 SKILL.md：frontmatter（---包围）+ Markdown 正文 */
export function parseSkillFile(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // 没有 frontmatter：整体作为正文，name 未知 → 视为无效
    return null;
  }

  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;

    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  if (!frontmatter.name) return null;
  return { frontmatter, body: match[2] };
}
