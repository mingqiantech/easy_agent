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

  it("deletes a session", () => {
    const s = sessions.create({});
    sessions.delete(s.id);
    expect(sessions.get(s.id)).toBeNull();
  });
});
