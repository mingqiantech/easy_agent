import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-w11-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "@easy-agent/core/database";
import { chunkText, RagIndex } from "../src/rag.js";
import { SkillManager, parseSkillFile } from "@easy-agent/core/skill/manager";

beforeAll(() => {
  getDatabase(process.env.EASY_AGENT_DB_PATH!);
});

describe("Week11: RAG chunking", () => {
  it("splits paragraphs into chunks under max size", () => {
    const text = ["para one", "para two", "x".repeat(600), "para four"].join("\n\n");
    const chunks = chunkText(text, "doc.md", { maxChunkSize: 500, overlap: 0 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(620);
    expect(chunks[0].documentId).toBe("doc.md");
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it("fixed-size splitting covers whole text", () => {
    const text = "a".repeat(1200);
    const chunks = chunkText(text, "flat.txt", {
      maxChunkSize: 500,
      overlap: 0,
      splitByParagraph: false,
    });
    expect(chunks.length).toBe(3);
    expect(chunks[2].endChar).toBe(1200);
  });

  it("empty text yields no chunks", () => {
    expect(chunkText("", "e.md")).toEqual([]);
  });
});

describe("Week11: RagIndex", () => {
  it("indexes files and retrieves relevant chunks", async () => {
    const dir = path.join(TEST_DIR, "kb");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "部署.md"),
      "# 部署\n\n使用 docker compose up -d 部署服务。\n\n# 无关\n\n香蕉很好吃。",
    );
    fs.writeFileSync(
      path.join(dir, "备份.md"),
      "# 备份\n\n每日凌晨执行 VACUUM INTO 备份数据库。",
    );

    const idx = new RagIndex();
    const { files, chunks } = await idx.addDirectory(dir);
    expect(files).toBe(2);
    expect(chunks).toBeGreaterThanOrEqual(2);

    const found = idx.retrieve("docker 部署");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].chunk.content).toContain("docker");
  });

  it("asks LLM with retrieved context (mock LLM)", async () => {
    const dir = path.join(TEST_DIR, "kb2");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.txt"), "项目的构建命令是 bun run build");

    const idx = new RagIndex();
    await idx.addDirectory(dir);

    let seenSystem = "";
    let seenPrompt = "";
    const mockLlm = async ({ system, prompt }: { system: string; prompt: string }) => {
      seenSystem = system;
      seenPrompt = prompt;
      return "构建命令是 `bun run build`（来源 1）";
    };

    const result = await idx.ask("怎么构建项目", mockLlm);
    expect(result.usedContext).toBe(true);
    expect(result.answer).toContain("bun run build");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(seenPrompt).toContain("bun run build"); // 上下文被注入
    expect(seenSystem).toContain("知识库问答");
  });

  it("answers gracefully when no context found", async () => {
    const idx = new RagIndex();
    const result = await idx.ask("火星天气", async () => "不应该被调用");
    expect(result.usedContext).toBe(false);
    expect(result.answer).toContain("未找到");
  });
});

describe("Week11: SkillManager", () => {
  const skillsDir = path.join(TEST_DIR, "skills");

  beforeAll(() => {
    fs.mkdirSync(path.join(skillsDir, "deploy-check"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "deploy-check", "SKILL.md"),
      `---
name: deploy-check
version: 1.0.0
description: 上线前检查流程
triggers: ["上线", "部署检查", "deploy check"]
requiredTools: ["bash", "read"]
---

# 上线检查

1. 运行测试
2. 检查配置
3. 备份数据库`,
    );

    // 无效技能：缺 frontmatter
    fs.mkdirSync(path.join(skillsDir, "broken"), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "broken", "SKILL.md"), "just text no frontmatter");
  });

  it("parses SKILL.md frontmatter", () => {
    const parsed = parseSkillFile(
      '---\nname: x\ntags: ["a", "b"]\n---\nbody here',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.name).toBe("x");
    expect(parsed!.frontmatter.tags).toEqual(["a", "b"]);
    expect(parsed!.body).toContain("body");
  });

  it("returns null for missing frontmatter or name", () => {
    expect(parseSkillFile("no frontmatter at all")).toBeNull();
    expect(parseSkillFile("---\nversion: 1\n---\nbody")).toBeNull();
  });

  it("scans skills dir, skipping invalid", async () => {
    const mgr = new SkillManager(skillsDir);
    const list = await mgr.scan();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("deploy-check");
    expect(list[0].triggers).toContain("上线");
    expect(list[0].requiredTools).toEqual(["bash", "read"]);
    expect(list[0].instructions).toContain("上线检查");
  });

  it("matches input by triggers", async () => {
    const mgr = new SkillManager(skillsDir);
    await mgr.scan();
    expect(mgr.match("我要做上线前的部署检查")?.name).toBe("deploy-check");
    expect(mgr.match("deploy check 一下")?.name).toBe("deploy-check");
    expect(mgr.match("今天天气如何")).toBeNull();
  });

  it("builds injectable skill prompt", async () => {
    const mgr = new SkillManager(skillsDir);
    await mgr.scan();
    const skill = mgr.get("deploy-check")!;
    const prompt = mgr.buildSkillPrompt(skill);
    expect(prompt).toContain('<skill name="deploy-check">');
    expect(prompt).toContain("上线检查");
  });

  it("missing skills dir yields empty list", async () => {
    const mgr = new SkillManager(path.join(TEST_DIR, "nonexistent"));
    expect(await mgr.scan()).toEqual([]);
  });
});
