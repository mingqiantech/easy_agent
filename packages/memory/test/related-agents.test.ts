import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ea-related-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { MemorySearcher } from "../src/search.js";
import { SimpleEmbeddingProvider } from "../src/embedding.js";
import { IncrementalIndex } from "../src/incremental-index.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { createMemorySearchTool, extractIndexTerms } from "../src/tool.js";

const xdb = freshDatabase(process.env.EASY_AGENT_DB_PATH!);

// 两个隔离工作区：tech（新）与 default（含历史）
const mk = (name: string, file: string, content: string) => {
  const ws = path.join(TEST_DIR, name);
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  fs.writeFileSync(path.join(ws, "MEMORY.md"), content, "utf-8");
  return ws;
};
const WS_TECH = mk(
  "tech",
  "MEMORY.md",
  "# Long-Term Memory\n\n- [重要] WSL2 NAT 模式下 Windows 访问需 portproxy\n",
);
const WS_DEF = mk(
  "defws",
  "MEMORY.md",
  "# Long-Term Memory\n\n- [重要] 用户偏好使用 bun 替代 node.js 运行 TypeScript\n- ComfyUI 视频部署走 NVIDIA Playbook\n",
);

describe("extractIndexTerms：从命中摘录提取二次检索索引词", () => {
  it("CJK 连续串与英文词提取、过滤查询已含词与虚词", () => {
    const terms = extractIndexTerms(
      ["用户偏好使用 bun 替代 node.js 运行 TypeScript，性能更好", "bun 工程统一用 tab 缩进"],
      "偏好",
      10,
    );
    expect(terms).toContain("bun");
    expect(terms).toContain("替代");
    expect(terms.join(" ")).not.toContain("偏好"); // 查询已含词不带路（含被长串包含的情况）
    expect(terms.length).toBeLessThanOrEqual(6);
  });
  it("按频次降序", () => {
    const terms = extractIndexTerms(["ComfyUI 视频 ComfyUI 部署 ComfyUI 稳定", "音频 pipeline"], "x");
    expect(terms[0]).toBe("comfyui");
  });
});

describe("relatedAgents 二次索引：主检索→索引词→关联工作区", () => {
  it("tech 主检索命中后，用索引词去关联 default 二查（stub 捕获查询+打 from 标签）", async () => {
    const techSearcher = new MemorySearcher(WS_TECH, path.join(WS_TECH, "memory"));
    let capturedQ2 = "";
    const fakeRel = {
      name: "default",
      searcher: new MemorySearcher(WS_DEF, path.join(WS_DEF, "memory")),
      hybrid: {
        search: async (q: string) => {
          capturedQ2 = q;
          return {
            mode: "hybrid" as const,
            hits: [{ path: "MEMORY.md", excerpt: "来自 default 的历史知识：bun 偏好", source: "memory" as const, vectorScore: 0.5, textScore: 0.3, combinedScore: 0.8 }],
          };
        },
      } as any,
    };
    const tool = createMemorySearchTool(techSearcher, {
      resolveRelated: (aid) => (aid === "tech" ? [fakeRel] : []),
    });
    const r: any = await tool.execute(
      { query: "portproxy WSL NAT", maxResults: 5 },
      { sessionId: "s", agentId: "tech", workDir: WS_TECH },
    );
    expect(r.hits.some((h: any) => h.from === "self" && String(h.excerpt).includes("portproxy"))).toBe(true);
    expect(r.related).toBeDefined();
    expect(r.related.agents).toEqual(["default"]);
    expect(r.related.terms.length).toBeGreaterThan(0);
    expect(capturedQ2.split(" ").length).toBeGreaterThan(0); // 索引词确实拼成查询去了关联区
    const sec = r.hits.filter((h: any) => h.from && h.from !== "self");
    expect(sec.length).toBe(1);
    expect(sec[0].from).toBe("default");
  });
  it("agentId 不在关联名单（resolveRelated 返回空）→ 无二查", async () => {
    const techSearcher = new MemorySearcher(WS_TECH, path.join(WS_TECH, "memory"));
    const tool = createMemorySearchTool(techSearcher, {
      resolveRelated: () => [],
    });
    const r: any = await tool.execute({ query: "portproxy", maxResults: 5 }, {
      sessionId: "s", agentId: "default", workDir: WS_TECH,
    });
    expect(r.related).toBeUndefined();
    expect(r.hits.every((h: any) => h.from === "self")).toBe(true); // 主命中统一标 self，与二查 from:<agent> 同坐标
  });
  it("主检索零命中（新空区全索引型）→ 查询词自身做钥匙二查", async () => {
    const emptyWs = path.join(TEST_DIR, "emptyws");
    fs.mkdirSync(path.join(emptyWs, "memory"), { recursive: true });
    const s = new MemorySearcher(emptyWs, path.join(emptyWs, "memory"));
    let capturedQ2 = "";
    const fakeRel = {
      name: "default",
      searcher: s,
      hybrid: {
        search: async (q: string) => {
          capturedQ2 = q;
          return { mode: "hybrid" as const, hits: [{ path: "MEMORY.md", excerpt: "bun 偏好历史知识", source: "memory" as const, vectorScore: 0.6, textScore: 0.4, combinedScore: 0.9 }] };
        },
      } as any,
    };
    const tool = createMemorySearchTool(s, { resolveRelated: () => [fakeRel] });
    const r: any = await tool.execute({ query: "TypeScript 运行工具 偏好", maxResults: 5 }, {
      sessionId: "s", agentId: "work", workDir: emptyWs,
    });
    expect(r.hits.length).toBe(0 + 1); // 只有跨区命中
    expect(r.hits[0].from).toBe("default");
    expect(capturedQ2.toLowerCase()).toContain("typescript");
    expect(r.related.agents).toEqual(["default"]);
  });
});

describe("HybridSearch prefixes 作用域（真实索引）", () => {
  it("各自工作区检索互不越界；传对方 prefixes 才可见", async () => {
    const embedding = new SimpleEmbeddingProvider();
    const idx = new IncrementalIndex(xdb, embedding, 256, "simple");
    await idx.indexFile(path.join(WS_TECH, "MEMORY.md"), "memory", "MEMORY.md");
    await idx.indexFile(path.join(WS_DEF, "MEMORY.md"), "memory", "MEMORY.md");

    const techHybrid = new HybridSearch(
      new MemorySearcher(WS_TECH, path.join(WS_TECH, "memory")),
      embedding, WS_TECH, idx.fts, idx.vec, xdb, {},
    );
    // "portproxy" 只属于 tech 语料
    const rT = await techHybrid.search("portproxy WSL", { limit: 5 });
    const ownExcerpts = rT.hits.map((h) => h.excerpt).join(" ");
    expect(ownExcerpts).toContain("portproxy");
    expect(ownExcerpts).not.toContain("ComfyUI"); // default 内容不混入
    // 用 default 前缀查 → 命中 default 语料
    const rD = await techHybrid.search("ComfyUI Playbook", { limit: 5, prefixes: [WS_DEF] });
    expect(rD.hits.map((h) => h.excerpt).join(" ")).toContain("ComfyUI");
    // ⚠️ 前缀边界：'…/defws' 式裸前缀带斜杠归一后不误伤（tech 目录名互为前缀的回归）
    const rBare = await techHybrid.search("ComfyUI", { limit: 5, prefixes: [WS_TECH] });
    expect(rBare.hits.map((h) => h.excerpt).join(" ")).not.toContain("ComfyUI");
  });
});
