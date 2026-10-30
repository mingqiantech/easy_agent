import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BasicMemory, extractLessonSections } from "@easy-agent/core/memory/basic";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-lesson-test-"));

describe("教训区注入：近 N 天日报复盘段落进 system prompt", () => {
  it("extractLessonSections 只收教训信号标题的小节", () => {
    const md = `# 2026-01-01

## 上午工作
正常内容，不该被收。

## 【真因复盘】连不上故障
- 教训1：HTTP 200 ≠ WS 握手正常

### 追加坑
- 小坑也收（4 级以下同级更浅标题截止）

## 次日计划
不该被收。
`;
    const out = extractLessonSections(md);
    expect(out).toContain("教训1：HTTP 200");
    expect(out).toContain("小坑也收");
    expect(out).not.toContain("不该被收");
    expect(out).not.toContain("正常内容");
  });

  it("fence 内的 # 标题不误判", () => {
    const md = "```\n## 教训示例（代码块内）\n```\n";
    expect(extractLessonSections(md)).toBe("");
  });

  it("buildSystemPrompt 含昨天日报教训、不含今天（今天全文另注入）", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const y = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000)
      .toISOString()
      .slice(0, 10);
    fs.mkdirSync(path.join(WORK, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(WORK, "memory", `${y}.md`),
      `## 教训（昨日）\n- 排障先 grep 日志 error 行\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(WORK, "memory", `${today}.md`),
      `# 今天\n## 教训（今日）\n- 今日新教训不该重复出现在教训区\n`,
      "utf-8",
    );
    const mem = new BasicMemory(WORK);
    const prompt = await mem.buildSystemPrompt();
    expect(prompt).toContain("recent_lessons");
    expect(prompt).toContain("排障先 grep 日志 error 行");
    // 今天那份在 diary_today 全文里，但教训区（从昨天往前数）不含它
    const lessonsBlock = /<recent_lessons>[\s\S]*?<\/recent_lessons>/.exec(prompt)?.[0] ?? "";
    expect(lessonsBlock).not.toContain("今日新教训不该重复出现在教训区");
  });

  it("env=0 禁用；window 外的旧教训不收", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    fs.writeFileSync(
      path.join(WORK, "memory", `${old}.md`),
      `## 教训（很久）\n- 30 天前的教训\n`,
      "utf-8",
    );
    const mem = new BasicMemory(WORK);
    const p1 = await mem.buildSystemPrompt();
    expect(p1).not.toContain("30 天前的教训");
    // 禁用开关
    process.env.EASY_AGENT_LESSON_DAYS = "0";
    const p2 = await mem.buildSystemPrompt();
    expect(p2).not.toContain("recent_lessons");
    delete process.env.EASY_AGENT_LESSON_DAYS;
  });
});
