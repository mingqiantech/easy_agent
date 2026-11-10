import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BasicMemory } from "../src/memory/basic.js";

/** matchSkill 触发词注入（2026-11-10 接通 SkillManager.match 死代码）回归 */
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "ea-skill-"));

describe("matchSkill（工作区技能触发词）", () => {
  beforeAll(() => {
    const dir = path.join(WS, "skills", "ocr-helper");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---
name: ocr-helper
description: 图片文字识别流程
triggers: ["识别文字", "图片转文字"]
---

遇到图片文字需求时，统一用 bash 跑：python3 ~/OCR_protert/ocr_tool.py <路径>
`,
    );
  });

  const mem = () => new BasicMemory(WS);

  it("命中触发词 → 返回技能含正文指令", async () => {
    const s = await mem().matchSkill("帮我把这张截图 图片转文字 一下");
    expect(s?.name).toBe("ocr-helper");
    expect(s?.instructions).toContain("ocr_tool.py");
  });

  it("未命中/空文本 → null（零注入）", async () => {
    expect(await mem().matchSkill("随便聊聊天气")).toBeNull();
    expect(await mem().matchSkill("   ")).toBeNull();
  });

  it("无 skills 目录的工作区不报错", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ea-noskill-"));
    expect(await new BasicMemory(empty).matchSkill("识别文字")).toBeNull();
  });
});
