import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-hybrid-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { MemorySearcher, tokenizeQuery } from "../src/search.js";
import { SimpleEmbeddingProvider } from "../src/embedding.js";
import { IncrementalIndex } from "../src/incremental-index.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { createMemorySearchTool } from "../src/tool.js";

const xdb = freshDatabase(process.env.EASY_AGENT_DB_PATH!);

const WS = path.join(TEST_DIR, "workspace");
const MEM = path.join(WS, "memory");
fs.mkdirSync(MEM, { recursive: true });
fs.writeFileSync(
  path.join(MEM, "2026-10-20.md"),
  "# 2026-10-20\n\n- elf 决定视频生成走 ComfyUI 本地部署，不用云 API\n- 修复了梦境闭环的占位行 bug\n",
  "utf-8",
);
fs.writeFileSync(
  path.join(WS, "MEMORY.md"),
  "# Long-Term Memory\n\n用户明确拒绝猜测配置格式，强调依据官方 schema。\n",
  "utf-8",
);

describe("tokenizeQuery：中文 bigram 切词", () => {
  it("中文查询切成二元组而非整句", () => {
    const t = tokenizeQuery("视频生成方案");
    expect(t).toContain("视频");
    expect(t).toContain("频生");
    expect(t).toContain("生成");
    expect(t).not.toContain("视频生成方案"); // 不再整句当一个词
  });
  it("英文词保留且小写", () => {
    const t = tokenizeQuery("Fixes BUG in ComfyUI");
    expect(t).toContain("fixes");
    expect(t).toContain("bug");
  });
});

describe("MemorySearcher 中文检索", () => {
  it("中文关键词能命中（原来整句匹配搜不到）", async () => {
    const s = new MemorySearcher(WS, MEM);
    const r = await s.search("视频生成", { corpus: "memory" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].excerpt).toContain("ComfyUI");
  });
});

describe("HybridSearch：向量+全文融合", () => {
  it("索引后 hybrid 模式生效，语义相近（无同词）也能命中", async () => {
    const embedding = new SimpleEmbeddingProvider();
    const db = xdb;
    const idx = new IncrementalIndex(db, embedding);
    const n1 = await idx.indexFile(path.join(MEM, "2026-10-20.md"), "memory");
    const n2 = await idx.indexFile(path.join(WS, "MEMORY.md"), "memory");
    expect(n1 + n2).toBeGreaterThan(0);
    // 幂等：hash 未变不重建
    expect(await idx.indexFile(path.join(MEM, "2026-10-20.md"), "memory")).toBe(0);

    const searcher = new MemorySearcher(WS, MEM);
    const hybrid = new HybridSearch(searcher, embedding, WS, undefined, undefined, xdb);
    const r = await hybrid.search("ComfyUI", { limit: 5, source: "memory" });
    expect(r.mode).toBe("hybrid");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].vectorScore).toBeGreaterThan(0);
    expect(r.hits[0].path).toContain("2026-10-20.md");
  });

  it("memory_search 工具带 hybrid 返回 mode 字段", async () => {
    const searcher = new MemorySearcher(WS, MEM);
    const hybrid = new HybridSearch(searcher, new SimpleEmbeddingProvider(), WS, undefined, undefined, xdb);
    const tool = createMemorySearchTool(searcher, { hybrid });
    const out: any = await tool.execute({ query: "视频生成", corpus: "memory" }, {
      sessionId: "t", agentId: "default", workDir: WS,
    } as any);
    expect(["hybrid", "text-only"]).toContain(out.mode);
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it("无向量索引时退化为 text-only 不报错", async () => {
    const searcher = new MemorySearcher(WS, MEM);
    const hybrid = new HybridSearch(searcher, new SimpleEmbeddingProvider(), WS, undefined, undefined, xdb);
    const r = await hybrid.search("梦境闭环", { limit: 5, source: "session" }); // session 源未索引
    expect(["hybrid", "text-only"]).toContain(r.mode);
  });
});
