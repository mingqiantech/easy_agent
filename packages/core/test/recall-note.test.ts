import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../src/database.js";
import { SessionManager } from "../src/session.js";

/** recallNote 尾巴注入（2026-11-11 检索式记忆）：进请求不进库 */
describe("run() recallNote", () => {
  let sessions: SessionManager;
  let lastRequest: any;

  beforeAll(() => {
    getDatabase(":memory:");
    const fakeLlm: any = {
      generate: async (req: any) => {
        lastRequest = req;
        return { content: "好的", usage: undefined, toolCalls: undefined };
      },
    };
    sessions = new SessionManager(fakeLlm, { defaultModel: "t/m" });
  });

  it("recallNote 作为末尾临时 system 进请求；DB 不落库", async () => {
    const s = sessions.create({ systemPrompt: "你是测试助手" });
    const note = "【检索片段】系统按本轮问题捞回：\n1. (相关度 0.62) 旧结论：ST3215 用 GPIO17";
    const resp = await sessions.run(s.id, "st3215 怎么接线", { recallNote: note });
    expect(resp).toContain("好的");
    const msgs = lastRequest.messages as any[];
    // 片段合并进最后一条 user（协议：末尾不能裸 system）
    const lastUser = msgs.filter((m) => m.role === "user").at(-1);
    expect(lastUser.content).toContain("怎么接线");
    expect(lastUser.content).toContain("【检索片段】");
    // 落库的历史不含片段（下一轮不会重放）
    const db = getDatabase();
    const stored = db
      .prepare("SELECT COUNT(*) c FROM messages WHERE session_id=? AND content LIKE ?")
      .get(s.id, "%【检索片段】%") as any;
    expect(stored.c).toBe(0);
    // 历史前缀零污染：system 块只有工作区头部一条
    expect(msgs.filter((m) => m.role === "system").length).toBe(1);
  });

  it("不传 recallNote 时零改动", async () => {
    const s = sessions.create({ systemPrompt: "你是测试助手" });
    await sessions.run(s.id, "随便一句", {});
    const last = lastRequest.messages.at(-1);
    expect(last.role).toBe("user");
    expect(last.content).toContain("随便一句");
  });
});
