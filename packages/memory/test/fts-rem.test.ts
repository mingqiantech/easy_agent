import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-fts-test-"));

import { freshDatabase } from "@easy-agent/core/database";
import { SimpleEmbeddingProvider } from "../src/embedding.js";
import type { EmbeddingProvider } from "../src/embedding.js";
import { IncrementalIndex } from "../src/incremental-index.js";
import { MemorySearcher } from "../src/search.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { remDreaming, type DreamingDeps } from "../src/dreaming.js";
import { ShortTermMemory } from "../src/short-term.js";

// 本文件专用独立 DB：bun test 文件并发，全局 DELETE/指纹重建不能碰共享单例
const xdb = freshDatabase(path.join(TEST_DIR, "state", "own.db"));

const WS = path.join(TEST_DIR, "workspace");
const MEM = path.join(WS, "memory");
fs.mkdirSync(MEM, { recursive: true });
const NOTE = path.join(MEM, "note.md");
fs.writeFileSync(
  NOTE,
  "# 笔记\n\n音频项目采用 ES8388  codecs，I2S 时钟配置为主模式。\n\n鸿蒙端用 NAPI 桥接驱动。\n",
  "utf-8",
);

describe("FTS5 BM25 关键词通道", () => {
  it("中文查询经 bigram 命中 BM25，分数归一", async () => {
    const db = xdb;
    const idx = new IncrementalIndex(db, new SimpleEmbeddingProvider(), 256, "test-fts");
    const n = await idx.indexFile(NOTE, "memory", "memory/note.md");
    expect(n).toBe(1); // 短段落会合并为一个 ≤500 字块
    const hits = idx.fts.search("时钟配置", { source: "memory" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("memory/note.md");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
    expect(idx.fts.search("不存在词", { source: "memory" })).toEqual([]);
  });

  it("文件更新后不留孤儿索引行", async () => {
    const db = xdb;
    const idx = new IncrementalIndex(db, new SimpleEmbeddingProvider(), 256, "test-fts");
    fs.writeFileSync(NOTE, "# 笔记\n\n新版内容只有蓝牙 A2DP 栈。\n", "utf-8");
    await idx.indexFile(NOTE, "memory", "memory/note.md");
    expect(idx.fts.search("时钟", { source: "memory" })).toEqual([]);
    expect(idx.fts.search("蓝牙", { source: "memory" }).length).toBe(1);
    const cnt = db
      .prepare("SELECT COUNT(*) c FROM memory_vec WHERE id IN (SELECT id FROM memory_entries WHERE file_path=?)")
      .get(NOTE) as any;
    expect(cnt.c).toBe(1); // vec 与 entry 一一对应，无孤儿
  });

  it("embedding 指纹变更 → 全量清空重建（换模型不混维度）", async () => {
    const db = xdb;
    expect((db.prepare("SELECT COUNT(*) c FROM memory_entries").get() as any).c).toBe(1);
    const idx2 = new IncrementalIndex(db, new SimpleEmbeddingProvider(), 256, "ollama:bge-m3"); // 模拟换 provider
    expect((db.prepare("SELECT COUNT(*) c FROM memory_entries").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM memory_vec").get() as any).c).toBe(0);
    expect(idx2.fts.search("蓝牙", { source: "memory" })).toEqual([]);
    // 同指纹再建不重复清
    await idx2.indexFile(NOTE, "memory", "memory/note.md");
    const idx3 = new IncrementalIndex(db, new SimpleEmbeddingProvider(), 256, "ollama:bge-m3");
    expect((db.prepare("SELECT COUNT(*) c FROM memory_entries").get() as any).c).toBe(1);
    expect(idx3.fts.search("蓝牙", { source: "memory" }).length).toBe(1);
  });

  it("HybridSearch 走 FTS 通道且命中喂 recall 统计（onHit）", async () => {
    const db = xdb;
    const idx = new IncrementalIndex(db, new SimpleEmbeddingProvider(), 256, "ollama:bge-m3");
    const searcher = new MemorySearcher(WS, MEM);
    const hitPaths: string[] = [];
    searcher.onHit = (p) => hitPaths.push(p);
    const hybrid = new HybridSearch(searcher, new SimpleEmbeddingProvider(), WS, idx.fts);
    const r = await hybrid.search("蓝牙", { limit: 5, source: "memory" });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].textScore).toBeGreaterThan(0);
    expect(hitPaths.some((p) => p.includes("note.md"))).toBe(true);
  });
});

describe("REM 主题反思", () => {
  const REM_WS = path.join(TEST_DIR, "rem-ws");
  function seed(n: number) {
    const db = xdb;
    db.prepare("DELETE FROM short_term_memory").run();
    db.prepare("DELETE FROM dreaming_state WHERE phase='rem'").run();
    const st = new ShortTermMemory(db);
    const texts = [
      "音频项目 I2S 时钟配置踩坑：主模式必须提前配置",
      "蓝牙 A2DP 协议栈移植完成，音频输出走蓝牙",
      "音频驱动的 DMA 缓冲区大小影响延迟",
      "鸿蒙 NAPI 桥接音频驱动的方案确认",
      "用户偏好先看官方 schema 再改配置",
    ].slice(0, n);
    for (const t of texts) st.add(t, `seed:${t.slice(0, 6)}`);
    return { db, st };
  }
  function deps(db: any, st: any, llm: (p: string) => Promise<string>): DreamingDeps {
    return {
      db,
      shortTerm: st,
      llmGenerate: llm,
      readMemory: async () => "",
      writeMemory: async () => {},
    };
  }

  it("归纳主题：相关条目强化 + 主题入短期记忆（首次不晋升）", async () => {
    const { db, st } = seed(5);
    const r = await remDreaming(deps(db, st, async () => "音频驱动|时钟与缓冲区配置是反复出现的坑"));
    expect(r.themes).toEqual(["音频驱动"]);
    const added = st.getActive().filter((e) => e.origin?.startsWith("rem:theme"));
    expect(added.length).toBe(1);
    expect(added[0].text).toContain("音频驱动");
    expect(added[0].recallCount).toBe(0); // 首次只是观察，不预热
    // 提及主题的条目 unique_queries 被强化（bigram 重叠≥2：音频/频驱/驱动）
    const boosted = db
      .prepare("SELECT unique_queries uq FROM short_term_memory WHERE text LIKE '%DMA%'")
      .get() as any;
    expect(boosted.uq).toBe(1);
    const notBoosted = db
      .prepare("SELECT unique_queries uq FROM short_term_memory WHERE text LIKE '%schema%'")
      .get() as any;
    expect(notBoosted.uq).toBe(0);
    // 主题历史入 state
    const state = JSON.parse((db.prepare("SELECT state FROM dreaming_state WHERE phase='rem'").get() as any).state);
    expect(state.themes[0].name).toBe("音频驱动");
  });

  it("同主题 7 天内再现 → 积累条目按重要预热（进晋升通道）", async () => {
    const { db, st } = seed(5);
    const llm = async () => "音频驱动|时钟与缓冲区配置是反复出现的坑";
    await remDreaming(deps(db, st, llm));
    // 隔一轮再来（模拟次日），直接构造：重新种 5 条（主题条目也活跃）
    const r2 = await remDreaming(deps(db, st, llm));
    expect(r2.themes).toEqual(["音频驱动"]);
    const accum = st.getActive().find((e) => e.text.includes("主题积累"));
    expect(accum).toBeTruthy();
    expect(accum!.recallCount).toBeGreaterThanOrEqual(3); // 已进晋升通道
  });

  it("活跃条目不足 4 条时跳过反思（不烧 LLM）", async () => {
    const { db, st } = seed(2);
    let called = false;
    const r = await remDreaming(deps(db, st, async () => { called = true; return "x|y"; }));
    expect(called).toBe(false);
    expect(r.themes).toEqual([]);
  });
});
