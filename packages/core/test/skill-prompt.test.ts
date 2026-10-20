import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BasicMemory } from "@easy-agent/core/memory/basic";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-skill-test-"));

describe("Skill 系统接入：发现 + 描述常驻 system prompt", () => {
  it("SKILL.md 被发现并在 prompt 中列名称/描述/路径", async () => {
    const dir = path.join(WORK, "skills", "ocr");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---
name: ocr
description: 图片文字识别，收到图片先跑 ocr_tool.py
triggers: [识别, 图片文字]
---

## 步骤
1. 运行 python3 ~/OCR_protert/ocr_tool.py <路径>
`,
      "utf-8",
    );
    const mem = new BasicMemory(WORK);
    const skills = await mem.listSkills();
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("ocr");
    expect(skills[0].dir).toBe(dir);

    const prompt = await mem.buildSystemPrompt();
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("**ocr**");
    expect(prompt).toContain("图片文字识别");
    expect(prompt).toContain(path.join(dir, "SKILL.md"));
    // 正文按需加载：描述常驻但步骤正文不注入
    expect(prompt).not.toContain("## 步骤");
  });

  it("无技能目录时 prompt 不含 Skills 段（零开销）", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-skill-none-"));
    const prompt = await new BasicMemory(empty).buildSystemPrompt();
    expect(prompt).not.toContain("Available Skills");
  });

  it("initWorkspace 生成示例技能并立即可被发现", async () => {
    const ws = path.join(WORK, "fresh-ws");
    const mem = new BasicMemory(ws);
    const created = await mem.initWorkspace();
    expect(created).toContain("skills/example/SKILL.md");
    const skills = await mem.listSkills();
    expect(skills.map((s) => s.name)).toContain("example");
    // 幂等：再跑一次不覆盖、不重复报创建
    const created2 = await mem.initWorkspace();
    expect(created2).not.toContain("skills/example/SKILL.md");
  });
});
