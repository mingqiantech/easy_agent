import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../src/database.js";
import { SessionManager } from "../src/session.js";

/** 压缩归档测试：旧消息进 messages_archive 而非物理删除，UI 全量历史不丢 */
describe("compactIfNeeded 归档（不删除历史）", () => {
  let sessions: SessionManager;

  beforeAll(() => {
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
