import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-archive-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { freshDatabase } from "@easy-agent/core/database";
import { ShortTermMemory } from "../src/short-term.js";
import {
  deepDreaming,
  loadDreamingConfig,
  DEFAULT_DREAMING_CONFIG,
} from "../src/dreaming.js";

const DAY_MS = 86400000;

describe("loadDreamingConfig：默认 + 文件 + env 覆盖", () => {
  it("默认值为长效参数包", () => {
    const cfg = loadDreamingConfig();
    expect(cfg.halfLifeDays).toBe(30);
    expect(cfg.reviewIntervals).toEqual([1, 3, 7, 16, 35]);
    expect(cfg.themeWindowDays).toBe(21);
    expect(cfg.forgetDays).toBe(90);
    expect(cfg.memoryBudgetChars).toBe(20000);
    expect(cfg.lightMaxMsgs).toBe(800);
  });

  it("env EASY_AGENT_DREAM_* 优先于文件覆盖", () => {
    process.env.EASY_AGENT_DREAM_HALF_LIFE_DAYS = "45";
    process.env.EASY_AGENT_DREAM_FORGET_DAYS = "0";
    process.env.EASY_AGENT_DREAM_REVIEW_INTERVALS = "1,2,3";
    process.env.EASY_AGENT_DREAM_DISTILL = "0";
    const cfg = loadDreamingConfig({ halfLifeDays: 40 });
    expect(cfg.halfLifeDays).toBe(45);
    expect(cfg.forgetDays).toBe(0);
    expect(cfg.reviewIntervals).toEqual([1, 2, 3]);
    expect(cfg.distillEnabled).toBe(false);
    delete process.env.EASY_AGENT_DREAM_HALF_LIFE_DAYS;
    delete process.env.EASY_AGENT_DREAM_FORGET_DAYS;
    delete process.env.EASY_AGENT_DREAM_REVIEW_INTERVALS;
    delete process.env.EASY_AGENT_DREAM_DISTILL;
  });
});

describe("L1 预算三级瀑布：蒸馏要点 → 迁 L2 主题档案（不删除）", () => {
  const xdb = freshDatabase(path.join(TEST_DIR, "archive.db"));

  function makeDeps(opts: {
    memory: string;
    budget: number;
    llmOut: (prompt: string) => Promise<string>;
    topics?: Record<string, string>;
  }) {
    const topics = opts.topics ?? {};
    let mem = opts.memory;
    return {
      db: xdb,
      shortTerm: new ShortTermMemory(xdb),
      dreaming: {
        ...DEFAULT_DREAMING_CONFIG,
        memoryBudgetChars: opts.budget,
        distillAgeDays: 21,
      },
      llmGenerate: opts.llmOut,
      readMemory: async () => mem,
      writeMemory: async (c: string) => { mem = c; },
      maskSecret: (t: string) => t,
      topicStore: {
        read: async (name: string) => topics[name] ?? null,
        write: async (name: string, content: string) => { topics[name] = content; },
      },
      topics,
      getMemory: () => mem,
    };
  }

  it("超预算：老段蒸馏迁 promoted-YYYYQn.md，[重要] 行 pinned 留守，新段保留", async () => {
    const old = new Date(Date.now() - 100 * DAY_MS).toISOString().slice(0, 10);
    const st = new ShortTermMemory(xdb);
    xdb.prepare("DELETE FROM short_term_memory").run();
    st.addImportant("[重要] 全新待晋升的重要事实条目", "test:seed");

    const memory =
      "# Long-Term Memory\n\n" +
      `## Promoted (${old})\n\n- 一月份排查了音频延迟问题并定位到时钟配置\n- 二月份整理了鸿蒙 NAPI 桥接驱动的踩坑记录\n- [重要] 用户要求回复必须中文且简短\n\n` +
      "## Promoted (2026-06-10)\n\n- 夏天测试段落内容占位，也是可迁移的普通条目\n";

    const d = makeDeps({
      memory,
      budget: 150,
      // 蒸馏返回 3 行而老段 movable 只有 2 行 → 数量不符回退原文迁移
      llmOut: async () => "• 音频延迟根因时钟\n• 鸿蒙NAPI踩坑\n• 多余的一行",
    });
    const r = await deepDreaming(d);
    expect(r.promoted).toBe(1);
    const topicContent = Object.values(d.topics).join("\n");
    // 预算挤下最老段（按段日期升序）：先 6-10 后 7-19 的 movable 行都迁入 L2
    expect(topicContent).toContain("夏天测试段落");
    expect(topicContent).toContain("音频延迟"); // 蒸馏返回行数不符 → 原文回退迁入
    expect(topicContent).toContain("鸿蒙 NAPI");
    // pinned 行留守 L1；新晋升的重要条目也在
    expect(d.getMemory()).toContain("[重要] 用户要求回复必须中文且简短");
    expect(d.getMemory()).toContain("全新待晋升的重要事实条目");
    expect(d.getMemory()).not.toContain("一月份排查"); // 老段 movable 已移出 L1
  });

  it("数量匹配时蒸馏生效：L2 存要点而非原文", async () => {
    const old = new Date(Date.now() - 60 * DAY_MS).toISOString().slice(0, 10);
    const d = makeDeps({
      memory:
        "# L\n\n" +
        `## Promoted (${old})\n\n- 十一月份对系统做了深度排查发现三个根因最后修复于 6cbffe7\n- 同期还整理了备份策略和恢复演练的完整流程文档\n`,
      budget: 60,
      llmOut: async () => "• 三根因修复(6cbffe7)\n• 备份恢复流程已成文",
      topics: {},
    });
    const dateObj = new Date(Date.now() - 60 * DAY_MS);
    const name = `promoted-${dateObj.getUTCFullYear()}Q${Math.floor(dateObj.getUTCMonth() / 3) + 1}.md`;
    const r = await deepDreaming({ ...d, shortTerm: new ShortTermMemory(xdb) });
    expect(r.migrated).toBe(2);
    expect(d.topics[name]).toContain("三根因修复(6cbffe7)");
    expect(d.topics[name]).not.toContain("深度排查发现三个根因最后修复");
  });

  it("无 topicStore 时退化为旧删段行为（不崩）", async () => {
    const st = new ShortTermMemory(xdb);
    xdb.prepare("DELETE FROM short_term_memory").run();
    const old = new Date(Date.now() - 40 * DAY_MS).toISOString().slice(0, 10);
    const d = {
      db: xdb,
      shortTerm: st,
      dreaming: { ...DEFAULT_DREAMING_CONFIG, memoryBudgetChars: 30 },
      llmGenerate: async () => "X",
      readMemory: async () =>
        `# L\n\n## Promoted (${old})\n\n- 一个足够老的段落里面的条目被删掉不迁移\n`,
      writeMemory: async () => {},
      maskSecret: (t: string) => t,
    };
    const r = await deepDreaming(d); // 无晋升条目也走老化维护
    expect(r.promoted).toBe(0);
    expect(r.migrated).toBe(1);
  });
});

describe("软休眠与复活：时间只排序不判死", () => {
  it("超观察期+零召回+低分 → dormant；检索命中 origin → 复活回活跃池", async () => {
    const xdb = freshDatabase(path.join(TEST_DIR, "dormant.db"));
    const st = new ShortTermMemory(xdb);
    const oldTs = Date.now() - 200 * DAY_MS;
    xdb
      .prepare(
        `INSERT INTO short_term_memory (id, text, origin, recall_count, unique_queries, recall_days, created_at)
         VALUES ('d1', '两百天没人理的老记忆条目内容', 'fileX', 0, 0, '[]', ?)`,
      )
      .run(oldTs);
    xdb
      .prepare(
        `INSERT INTO short_term_memory (id, text, origin, recall_count, unique_queries, recall_days, created_at, last_recalled_at)
         VALUES ('d2', '两百天前但常被召回的热门条目', 'fileY', 8, 4, '["2026-10-01"]', ?, ?)`,
      )
      .run(oldTs, Date.now());

    const d = {
      db: xdb,
      shortTerm: st,
      dreaming: DEFAULT_DREAMING_CONFIG,
      llmGenerate: async () => "无",
      readMemory: async () => "# L\n",
      writeMemory: async () => {},
      maskSecret: (t: string) => t,
    };
    const r = await deepDreaming(d);
    expect(r.forgotten).toBe(1); // 只有 d1 休眠
    const got = xdb.prepare("SELECT dormant_at FROM short_term_memory WHERE id IN ('d1','d2')").all() as any[];
    expect(got[0].dormant_at).not.toBeNull();
    expect(got[1].dormant_at).toBeNull(); // 高召回热门条目分数过线，不睡

    // 检索命中 → 复活
    st.incrementRecall("fileX");
    const revived = xdb.prepare("SELECT dormant_at, recall_count c FROM short_term_memory WHERE id='d1'").get() as any;
    expect(revived.dormant_at).toBeNull();
    expect(revived.c).toBe(1);
  });

  it("forgetDays=0 完全关闭按龄休眠", async () => {
    const xdb = freshDatabase(path.join(TEST_DIR, "nodorm.db"));
    const st = new ShortTermMemory(xdb);
    xdb
      .prepare(
        `INSERT INTO short_term_memory (id, text, origin, recall_count, unique_queries, recall_days, created_at)
         VALUES ('n1', '很久没人理但配置了永不休眠', 'f', 0, 0, '[]', ?)`,
      )
      .run(Date.now() - 500 * DAY_MS);
    const r = await deepDreaming({
      db: xdb,
      shortTerm: st,
      dreaming: { ...DEFAULT_DREAMING_CONFIG, forgetDays: 0 },
      llmGenerate: async () => "无",
      readMemory: async () => "# L\n",
      writeMemory: async () => {},
      maskSecret: (t: string) => t,
    });
    expect(r.forgotten).toBe(0);
  });
});
