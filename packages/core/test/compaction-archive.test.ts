import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../src/database.js";
import { SessionManager } from "../src/session.js";

/** 压缩归档测试：旧消息进 messages_archive 而非物理删除，UI 全量历史不丢 */
describe("compactIfNeeded 归档（不删除历史）", () => {
  let sessions: SessionManager;

  beforeAll(() => {
    // 阈值改为 env 可调后，测试压低触发线（生产默认 64000 token 等价位）
    process.env.EASY_AGENT_COMPACT_MAX_TOKENS = "8000";
    getDatabase(":memory:");
    let n = 0;
    const fakeLlm: any = {
      generate: async () => ({ content: `这是第 ${++n} 次压缩摘要` }),
    };
    sessions = new SessionManager(fakeLlm, { defaultModel: "test/model" });
  });

  it("超阈值触发压缩：旧消息归档，getFullMessages 保留全量", async () => {
    const s = sessions.create({ systemPrompt: "你是测试助手" });
    // 塞 60 条长消息（> MAX_MESSAGES=50 且 chars > 32000）
    for (let i = 0; i < 60; i++) {
      sessions.addMessage(s.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `消息 ${i} ` + "x".repeat(600),
      });
    }
    const before = sessions.getMessages(s.id).length;
    expect(before).toBe(61); // 60 + system prompt

    const did = await sessions.compactIfNeeded(s.id);
    expect(did).toBe(true);

    const active = sessions.getMessages(s.id);
    // LLM 上下文只剩：system prompt + 摘要 + 最近 10 条
    expect(active.length).toBeLessThanOrEqual(12);
    expect(
      active.some(
        (m) => m.role === "system" && m.content.includes("[对话摘要]"),
      ),
    ).toBe(true);

    // 归档 + 活跃 = 原始非摘要消息数 + 1 条摘要
    const full = sessions.getFullMessages(s.id);
    const archived = full.filter((m: any) => m.archived).length;
    // 原始非 system 消息 60 条，最近 10 条保留在 active，其余 50 条归档
    expect(archived).toBe(before - 1 - (active.length - 2)); // 除 system+摘要外全部在归档
    expect(full.length).toBe(before + 1); // 全量历史（含摘要）

    // 归档的消息按时间可排序且内容完整
    const old = full.filter((m: any) => m.archived);
    expect(old[0].content).toContain("消息 0");
    expect(old[old.length - 1].role).toBeTruthy();
  });

  it("二次压缩：新摘要追加，旧摘要保留，历史继续完整", async () => {
    const s = sessions.list(10)[0];
    const sid = s.id;
    for (let i = 0; i < 60; i++) {
      sessions.addMessage(sid, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `第二轮 ${i} ` + "y".repeat(600),
      });
    }
    const fullBefore = sessions.getFullMessages(sid).length;
    const activeBefore = sessions.getMessages(sid).length;

    const did = await sessions.compactIfNeeded(sid);
    expect(did).toBe(true);

    const activeAfter = sessions.getMessages(sid);
    const summaries = activeAfter.filter(
      (m) => m.role === "system" && m.content.includes("[对话摘要]"),
    );
    expect(summaries.length).toBe(2); // 两次摘要都在（内容不同）
    expect(activeAfter.length).toBeLessThan(activeBefore);

    // 全量历史只增不减（新增 1 条摘要，其余从 active 挪到 archive）
    const fullAfter = sessions.getFullMessages(sid);
    expect(fullAfter.length).toBe(fullBefore + 1);
  });
});

describe("摘要质量闸门（空壳摘要回归防护 2026-10-27）", () => {
  beforeAll(() => {
    process.env.EASY_AGENT_COMPACT_MAX_TOKENS = "2000"; // 8k 字符即触发（消息数仍要 >50）
  });
  const big = (_s: string) => "x".repeat(1600);
  function seedMany(sm: any, id: string) {
    for (let i = 0; i < 52; i++) {
      sm.addMessage(id, { role: i % 4 === 0 ? "user" : i % 4 === 1 ? "assistant" : i % 4 === 2 ? "tool" : "assistant",
        content: i % 4 === 2
          ? JSON.stringify({ toolCallId: `t${i}`, toolName: "webfetch", result: big(String(i)) })
          : i % 4 === 1
            ? JSON.stringify({ text: `第${i}步：查到了价格 12345 元，准备汇总`, toolCalls: [{ id: `t${i}`, name: "bash", input: {} }] })
            : `第${i}轮消息内容，足够长以填充预算`.repeat(20) });
    }
  }

  it("LLM 摘要返回空 → 抽取式兕底，摘要不为空壳", async () => {
    const stub: any = { generate: async () => ({ content: "" }), stream: async function* () {} };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    seedMany(sm, s.id);
    await sm.compactIfNeeded(s.id);
    const sys = sm.getMessages(s.id).filter((m: any) => m.role === "system" && String(m.content).includes("[对话摘要]")) as any[];
    expect(sys.length).toBe(1);
    expect(sys[0].content.length).toBeGreaterThan(30); // 不再是 7 字符空壳
    expect(sys[0].content).toContain("用户诉求"); // 抽取式骨架三段至少成头一段
  });

  it("摘要输入清洗：tool 大段 JSON 不进摘要提示词，只留动作行", async () => {
    let seenPrompt = "";
    const stub: any = {
      generate: async (req: any) => { seenPrompt = req.messages[0].content; return { content: "## 用户诉求\n查价\n## 已完成/已查明\n价格 12345 元\n## 待办/下一步\n汇总回复" }; },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    seedMany(sm, s.id);
    await sm.compactIfNeeded(s.id);
    expect(seenPrompt).not.toContain("xxxxxxxx"); // 原始 HTML/结果正文被剔除
    expect(seenPrompt).toContain("已执行 webfetch");
    expect(seenPrompt.length).toBeLessThan(20000); // 13k×条数的原始体量不会再压垮小模型
  });

  it("摘要过短（<20 字）→ 重试一次成功则采用", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => { calls++; return { content: calls === 1 ? "短" : "## 用户诉求\n好摘要第二次返回，长度足够通过闸门校验" }; },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    seedMany(sm, s.id);
    await sm.compactIfNeeded(s.id);
    expect(calls).toBe(2);
    const sys = sm.getMessages(s.id).filter((m: any) => m.role === "system" && String(m.content).includes("[对话摘要]")) as any[];
    expect(sys[0].content).toContain("好摘要第二次返回");
  });
});
