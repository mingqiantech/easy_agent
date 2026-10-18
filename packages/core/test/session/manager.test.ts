import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../../src/database.js";
import { SessionManager } from "../../src/session.js";
import { LLMClient } from "@easy-agent/llm/client";

describe("SessionManager", () => {
  let sessions: SessionManager;

  beforeAll(() => {
    const db = getDatabase(":memory:");
    const llm = new LLMClient({ providers: {} });
    sessions = new SessionManager(llm, { defaultModel: "test/model" });
  });

  it("creates a session", () => {
    const s = sessions.create({ model: "test/model" });
    expect(s.id).toBeTruthy();
    expect(s.model).toBe("test/model");
    expect(s.status).toBe("active");
  });

  it("lists sessions", () => {
    const list = sessions.list();
    expect(list.length).toBeGreaterThan(0);
    // 回归测试：updateAt 曾因错误列名 row.update_at 恒为 undefined
    const s = list[0]!;
    expect(typeof s.updateAt).toBe("number");
    expect(s.updateAt).toBeGreaterThanOrEqual(s.createAt);
  });

  it("adds and retrieves messages", () => {
    const s = sessions.create({});
    sessions.addMessage(s.id, { role: "user", content: "hello" });
    sessions.addMessage(s.id, { role: "assistant", content: "hi" });
    const msgs = sessions.getMessages(s.id);
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].content).toBe("hi");
  });

  it("queueMessage 需要会话正在运行（转向/排队基础）", () => {
    const s = sessions.create({});
    expect(sessions.isBusy(s.id)).toBe(false);
    // 会话没在跑 → 不入队（调用方直接 run），不产生孤儿消息
    expect(sessions.queueMessage(s.id, "插话")).toBe(false);
    sessions.delete(s.id);
  });

  it("onEvent 流式路径：文本增量事件、落库与 token_usage 记录", async () => {
    const stub: any = {
      generate: () => {
        throw new Error("streaming 路径不应调用 generate");
      },
      stream: async function* () {
        yield { type: "text", text: "你好" };
        yield { type: "text", text: "世界" };
        yield {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const events: any[] = [];
    const out = await sm.run(s.id, "hi", {
      onEvent: (e: any) => events.push(e),
    });
    expect(out).toBe("你好世界");
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("你好世界");
    expect(sm.getMessages(s.id).filter((m) => m.role === "assistant").length).toBe(1);
    const u = getDatabase()
      .prepare("SELECT COUNT(*) n FROM token_usage WHERE session_id=?")
      .get(s.id) as any;
    expect(u.n).toBe(1);
  });

  it("deletes a session", () => {
    const s = sessions.create({});
    sessions.delete(s.id);
    expect(sessions.get(s.id)).toBeNull();
  });
});
