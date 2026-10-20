import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-rerank-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { SimpleEmbeddingProvider } from "../src/embedding.js";
import { IncrementalIndex } from "../src/incremental-index.js";
import { MemorySearcher } from "../src/search.js";
import { HybridSearch } from "../src/hybrid-search.js";
import { lightDreaming } from "../src/dreaming.js";
import { ShortTermMemory } from "../src/short-term.js";
import { initSecretMask, maskSecrets } from "@easy-agent/core/secrets-mask";

const db = freshDatabase(process.env.EASY_AGENT_DB_PATH!);
const WS = path.join(TEST_DIR, "workspace");
const MEM = path.join(WS, "memory");
fs.mkdirSync(MEM, { recursive: true });

describe("MMR 去冗余 + 时间衰减", () => {
  const embedding = new SimpleEmbeddingProvider();
  const idx = new IncrementalIndex(db, embedding, 256, "test-rerank");

  it("近似重复的块被 MMR 挤掉，结果更多样", async () => {
    const dupA = path.join(MEM, "dup1.md");
    const dupB = path.join(MEM, "dup2.md");
    const uniq = path.join(MEM, "uniq.md");
    fs.writeFileSync(dupA, "# 报告\n\n季度营收增长 12% 利润率持平 现金流健康 无大额支出 客户流失率稳定\n", "utf-8");
    fs.writeFileSync(dupB, "# 报告\n\n季度营收增长 12% 利润率基本持平 现金流健康 无大额支出 客户流失率稳定\n", "utf-8");
    fs.writeFileSync(uniq, "# 报告\n\n蓝牙 A2DP 协议栈延迟测试 端到端 80ms 编解码 LDAC 重传率 0.1%\n", "utf-8");
    for (const f of [dupA, dupB, uniq]) await idx.indexFile(f, "memory", "memory/" + path.basename(f));

    const searcher = new MemorySearcher(WS, MEM);
    // 关衰减保证纯分数主导
    const noMmr = new HybridSearch(searcher, embedding, WS, idx.fts, idx.vec, db, { mmr: false });
    const withMmr = new HybridSearch(searcher, embedding, WS, idx.fts, idx.vec, db, { mmr: true, lambda: 0.3 });

    const r1 = await noMmr.search("营收 增长 利润率", { limit: 2, source: "memory" });
    const r2 = await withMmr.search("营收 增长 利润率", { limit: 2, source: "memory" });
    const paths1 = r1.hits.map((h) => h.path).sort();
    const paths2 = r2.hits.map((h) => h.path);
    // 无 MMR：两条几乎同文的 dup 都进 TopK；MMR：第二条被去冗，让位给别的
    expect(paths1.join()).toContain("dup");
    const dupCount2 = paths2.filter((p) => p.includes("dup")).length;
    expect(dupCount2).toBeLessThanOrEqual(1);
  });

  it("时间衰减压低旧条目排名（新同分条目上位）", async () => {
    const old = path.join(MEM, "old.md");
    const fresh = path.join(MEM, "fresh.md");
    fs.writeFileSync(old, "# 主题\n\n配置文件统一放在 config 目录管理\n", "utf-8");
    await idx.indexFile(old, "memory", "memory/old.md");
    fs.writeFileSync(fresh, "# 主题\n\n配置文件统一放在 config 目录管理\n", "utf-8");
    await idx.indexFile(fresh, "memory", "memory/fresh.md");
    // 手动把 old 的时间推到 60 天前
    db.prepare("UPDATE memory_entries SET updated_at = updated_at - ? WHERE file_path = ?")
      .run(60 * 86400000, old);

    const searcher = new MemorySearcher(WS, MEM);
    const hyb = new HybridSearch(searcher, embedding, WS, idx.fts, idx.vec, db, { halfLifeDays: 14, mmr: false });
    const r = await hyb.search("配置文件 config 目录", { limit: 2, source: "memory" });
    expect(r.hits[0].path).toContain("fresh.md"); // 同文竞争，新者胜
    const scores = r.hits.map((h) => h.combinedScore);
    expect(scores[0]).toBeGreaterThan(scores[1]!); // 60 天前块被衰减
  });
});

describe("脱敏层：Dreaming 不外泄密钥", () => {
  it("lightDreaming 送 LLM 前掩掉 .env 值；REM/deep 同样脱敏", async () => {
    // 运行时拼接：命令/文件文本里不出现完整密钥串，防传输链路自身把它掩成 ***
    const secret = ["Zeta", "Long", "Test", "No", "Prefix", "98765"].join("");
    const stateDir = process.env.EASY_AGENT_STATE_DIR!;
    fs.writeFileSync(path.join(stateDir, ".env"), "TEST_SECRET_TOKEN=" + secret + "\n");
    initSecretMask(stateDir);

    // 种一条含密钥的消息
    const sid = "mask-test";
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id,title,agent_id,model,created_at,updated_at) VALUES (?,'脱敏','default','t',?,?)`,
    ).run(sid, Date.now(), Date.now());
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,created_at) VALUES (?,?,?,?,?)",
    ).run(`m-${Date.now()}`, sid, "user", `我的令牌是 ${secret} 帮我记住`, Date.now());

    let capturedPrompt = "";
    let capturedWrite = "";
    const st = new ShortTermMemory(db);
    const deps = {
      db,
      shortTerm: st,
      llmGenerate: async (p: string) => { capturedPrompt = p; return "• 用户提供了访问令牌用于系统对接\n• [重要] 令牌已登记在密码管理器"; },
      readMemory: async () => "# M\n",
      writeMemory: async (c: string) => { capturedWrite = c; },
      maskSecret: maskSecrets,
    };
    await lightDreaming(deps);
    expect(capturedPrompt).not.toContain(secret);
    expect(capturedPrompt).toContain("***");

    // REM 主题 prompt 同样脱敏（把密钥写进活跃条目文本模拟历史遗留）
    st.add(`遗留密钥 ${secret} 需要清理，这条用于脱敏回归测试`, "legacy:test");
    for (let i = 0; i < 4; i++) st.add(`无关条目占位 ${i}${"填充内容确保反思触发"}`, "legacy:pad");
    capturedPrompt = "";
    await (await import("../src/dreaming.js")).remDreaming(deps);
    expect(capturedPrompt).not.toContain(secret);
    if (capturedWrite) expect(capturedWrite).not.toContain(secret);
  });
});
