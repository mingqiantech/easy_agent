import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-vec-spaced-"));
const DAY_MS = 86400000;

import { freshDatabase } from "@easy-agent/core/database";
import { SimpleEmbeddingProvider } from "../src/embedding.js";
import { IncrementalIndex } from "../src/incremental-index.js";
import { MemorySearcher } from "../src/search.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { remDreaming } from "../src/dreaming.js";
import { ShortTermMemory } from "../src/short-term.js";

const db = freshDatabase(path.join(TEST_DIR, "state", "own.db"));
const WS = path.join(TEST_DIR, "workspace");
const MEM = path.join(WS, "memory");
fs.mkdirSync(MEM, { recursive: true });
const F1 = path.join(MEM, "a.md");
fs.writeFileSync(F1, "# A\n\n视频生成用 ComfyUI 本地部署。\n", "utf-8");
const F2 = path.join(MEM, "b.md");
fs.writeFileSync(F2, "# B\n\n音频驱动 DMA 缓冲区调优记录。\n", "utf-8");

describe("sqlite-vec KNN 加速", () => {
  const embedding = new SimpleEmbeddingProvider();
  const idx = new IncrementalIndex(db, embedding, 256, "test-vec-spaced");

  it("扩展可加载且 vec0 按真实维度建立", async () => {
    if (!idx.vec.available) return; // 环境无扩展→跳过（brute-force 兜底路径另有覆盖）
    await idx.indexFile(F1, "memory", "memory/a.md");
    await idx.indexFile(F2, "memory", "memory/b.md");
    expect(idx.vec.ready).toBe(true);
    const cnt = (db.prepare("SELECT COUNT(*) c FROM memory_vec_v").get() as any).c;
    expect(cnt).toBe(2);
  });

  it("KNN 分数与暴力 cosine 一致，HybridSearch 走向量通道", async () => {
    const searcher = new MemorySearcher(WS, MEM);
    const hybrid = new HybridSearch(searcher, embedding, WS, idx.fts, idx.vec);
    const r = await hybrid.search("视频生成", { limit: 2, source: "memory" });
    expect(r.hits.length).toBe(2);
    expect(r.hits[0].path).toContain("a.md");
    expect(r.hits[0].vectorScore).toBeGreaterThan(r.hits[1].vectorScore);
  });

  it("文件重索引同步更新 vec（rowid 跟随新 entry id，无孤儿）", async () => {
    if (!idx.vec.ready) return;
    fs.writeFileSync(F1, "# A2\n\n完全重写的内容 蓝牙 A2DP。\n", "utf-8");
    const n = await idx.indexFile(F1, "memory", "memory/a.md");
    expect(n).toBe(1);
    const orphans = (db
      .prepare("SELECT COUNT(*) c FROM memory_vec_v v LEFT JOIN memory_entries e ON e.id=v.rowid WHERE e.id IS NULL")
      .get() as any).c;
    expect(orphans).toBe(0);
    const searcher = new MemorySearcher(WS, MEM);
    const hybrid = new HybridSearch(searcher, embedding, WS, idx.fts, idx.vec);
    const r = await hybrid.search("蓝牙", { limit: 1, source: "memory" });
    expect(r.hits[0].path).toContain("a.md"); // 旧向量已换，新内容可检索
  });
});

describe("REM spaced-reinforcement 复习调度", () => {
  function seedRecalled(text: string, rc: number): string {
    const st = new ShortTermMemory(db);
    const id = st.add(text, `spaced:${text.slice(0, 4)}`);
    db.prepare("UPDATE short_term_memory SET recall_count=?, unique_queries=1 WHERE id=?").run(rc, id);
    return id;
  }
  const depsFor = (llm: string) => ({
    db,
    shortTerm: new ShortTermMemory(db),
    llmGenerate: async () => llm,
    readMemory: async () => "",
    writeMemory: async () => {},
    maskSecret: (t: string) => t,
  });

  it("被检索未达标条目入队；到期复习合成 recall+1 并记日期", async () => {
    db.prepare("DELETE FROM short_term_memory").run();
    db.prepare("DELETE FROM dreaming_state WHERE phase='rem'").run();
    const id = seedRecalled("音频延迟问题第三次出现", 1);

    // 第一轮：入队（due=明天），不 bump
    await remDreaming(depsFor("无"));
    let rv = JSON.parse((db.prepare("SELECT state FROM dreaming_state WHERE phase='rem'").get() as any).state).reviews[id];
    expect(rv).toBeTruthy();
    expect((db.prepare("SELECT recall_count c FROM short_term_memory WHERE id=?").get(id) as any).c).toBe(1);

    // 伪造到期（due=昨天，step=1）→ 再跑：bump + 间隔升档
    rv = { step: 1, due: Date.now() - DAY_MS };
    db.prepare("UPDATE dreaming_state SET state=? WHERE phase='rem'").run(JSON.stringify({ reviews: { [id]: rv } }));
    await remDreaming(depsFor("无"));
    const row = db.prepare("SELECT recall_count c, recall_days d FROM short_term_memory WHERE id=?").get(id) as any;
    expect(row.c).toBe(2); // 复习合成召回
    expect(JSON.parse(row.d).length).toBeGreaterThanOrEqual(1); // 间隔日期被记录
    const after = JSON.parse((db.prepare("SELECT state FROM dreaming_state WHERE phase='rem'").get() as any).state).reviews[id];
    expect(after.step).toBe(2); // 新默认五档 [1,3,7,16,35]：step1→2
  });

  it("已达标条目不入队；晋升/遗忘条目自动退队", async () => {
    db.prepare("DELETE FROM short_term_memory").run();
    db.prepare("DELETE FROM dreaming_state WHERE phase='rem'").run();
    const readyId = seedRecalled("已达标待晋升条目，内容充足", 3); // rc=3 uq=1 → unique 不足仍不入队? rc>=3 但 uq=1<2
    const st = new ShortTermMemory(db);
    // 直接达标（rc3 uq2）的不入队
    db.prepare("UPDATE short_term_memory SET unique_queries=2 WHERE id=?").run(readyId);
    await remDreaming(depsFor("无"));
    let state = JSON.parse((db.prepare("SELECT state FROM dreaming_state WHERE phase='rem'").get() as any).state);
    expect(state.reviews[readyId]).toBeUndefined();

    // 晋升后退队
    db.prepare("UPDATE short_term_memory SET promoted_at=? WHERE id=?").run(Date.now(), readyId);
    const otherId = seedRecalled("普通命中条目也要复习它", 1);
    await remDreaming(depsFor("无"));
    state = JSON.parse((db.prepare("SELECT state FROM dreaming_state WHERE phase='rem'").get() as any).state);
    expect(state.reviews[readyId]).toBeUndefined();
    expect(state.reviews[otherId]).toBeTruthy();
  });

  it("最后一级复习毕业（不再留在队列）", async () => {
    db.prepare("DELETE FROM short_term_memory").run();
    db.prepare("DELETE FROM dreaming_state WHERE phase='rem'").run();
    const id = seedRecalled("毕业测试条目内容，间隔训练", 1);
    await remDreaming(depsFor("无")); // 入队 step0
    // 手动置为到期最后一级 step=4（五档：1/3/7/16/35）
    db.prepare("UPDATE dreaming_state SET state=? WHERE phase='rem'").run(
      JSON.stringify({ reviews: { [id]: { step: 4, due: Date.now() - 1 } } }),
    );
    await remDreaming(depsFor("无"));
    const state = JSON.parse((db.prepare("SELECT state FROM dreaming_state WHERE phase='rem'").get() as any).state);
    expect(state.reviews[id]).toBeUndefined(); // 五级练完毕业
    const row = db.prepare("SELECT recall_count c FROM short_term_memory WHERE id=?").get(id) as any;
    expect(row.c).toBe(2); // 1 + 毕业复习 1 次
  });
});
