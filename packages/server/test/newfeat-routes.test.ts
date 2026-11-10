import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ea-newfeat-"));
process.env.EASY_AGENT_STATE_DIR = DIR;
process.env.EASY_AGENT_UPLOADS_DIR = DIR;

const { createApp } = await import("../src/app.js");
const { getDatabase } = await import("@easy-agent/core/database");
const { LLMClient } = await import("@easy-agent/llm/client");
const { SessionManager } = await import("@easy-agent/core/session");
const { ToolRegistry } = await import("@easy-agent/core/tool/registry");
const { BasicMemory } = await import("@easy-agent/core/memory/basic");

function stub(configPatch: any = {}) {
  const llm = new LLMClient({ providers: {} });
  const sessions = new SessionManager(llm, { defaultModel: "t/m" });
  const memory = new BasicMemory(DIR);
  const agent: any = {
    name: "life", model: "t/m", description: "t", workspaceDir: DIR,
    memory, thinking: "off", toolsDisable: [],
  };
  return {
    sessions,
    deps: {
      llm, sessions, tools: new ToolRegistry(false), memory,
      config: { stateDir: DIR, workspaceDir: DIR, ...configPatch },
      agents: { life: agent },
    } as any,
  };
}

describe("outbox 发件箱", () => {
  it("POST 需 chatId（body 或 config.wecom.alertChatId）；GET pending；ack 后消失", async () => {
    const { deps } = stub({ wecom: { alertChatId: "chat-9" } });
    const app = createApp(deps);
    let r = await app.request("/api/outbox", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "🚨 测试告警" }),
    });
    expect(r.status).toBe(201);
    const { id } = await r.json() as any;
    // 缺文本 400
    r = await app.request("/api/outbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(400);
    let j: any = await (await app.request("/api/outbox")).json();
    expect(j.pending.some((x: any) => x.id === id && x.chatId === "chat-9" && x.text === "🚨 测试告警")).toBe(true);
    await app.request(`/api/outbox/${id}/ack`, { method: "POST" });
    j = await (await app.request("/api/outbox")).json();
    expect(j.pending.some((x: any) => x.id === id)).toBe(false);
  });
});

describe("approvals API", () => {
  it("手工插 pending → GET 可见 → resolve allow/deny 生效，重复 resolve 无效", async () => {
    const { deps } = stub({ approvals: { enabled: true } });
    const app = createApp(deps);
    const db = getDatabase();
    db.prepare("INSERT INTO approvals (session_id, agent_id, tool_name, detail, reason, created_at) VALUES ('sX','life','bash','rm -rf x','default',?)").run(Date.now());
    let j: any = await (await app.request("/api/approvals")).json();
    expect(j.enabled).toBe(true);
    const item = j.pending.find((x: any) => x.sessionId === "sX");
    expect(item.tool).toBe("bash");
    let r = await app.request(`/api/approvals/${item.id}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "allow" }),
    });
    expect((await r.json() as any).ok).toBe(true);
    // 二次 resolve（已非 pending）→ ok:false
    r = await app.request(`/api/approvals/${item.id}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deny" }),
    });
    expect((await r.json() as any).ok).toBe(false);
    expect((await (await app.request("/api/approvals")).json() as any).pending.some((x: any) => x.id === item.id)).toBe(false);
    // 非法 action
    r = await app.request(`/api/approvals/${item.id}/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "maybe" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("skills CRUD + 触发测试", () => {
  it("PUT 新建 → GET 列表/详情 → test 命中 → DELETE 删除", async () => {
    const { deps } = stub({});
    const app = createApp(deps);
    let r = await app.request("/api/skills/wiring-guide?agent=life", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "---\nname: wiring-guide\ndescription: 接线图流程\ntriggers: [\"接线图\"]\n---\n\n先查手册再画图。\n" }),
    });
    expect((await r.json() as any).ok).toBe(true);
    let list: any = await (await app.request("/api/skills?agent=life")).json();
    expect(list.skills.some((k: any) => k.name === "wiring-guide" && k.triggers.includes("接线图"))).toBe(true);
    const det: any = await (await app.request("/api/skills/wiring-guide?agent=life")).json();
    expect(det.markdown).toContain("先查手册");
    const t: any = await (await app.request("/api/skills/test", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "life", text: "帮我画个接线图" }),
    })).json();
    expect(t.matched).toBe("wiring-guide");
    // 非法名 400
    r = await app.request("/api/skills/bad%20name?agent=life", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect([400, 404]).toContain(r.status);
    await app.request("/api/skills/wiring-guide?agent=life", { method: "DELETE" });
    list = await (await app.request("/api/skills?agent=life")).json();
    expect(list.skills.some((k: any) => k.name === "wiring-guide")).toBe(false);
  });
});

describe("会话导出", () => {
  it("md 含角色/时间头；json 结构完整；未知会话 404", async () => {
    const { deps, sessions } = stub({});
    const app = createApp(deps);
    const s = sessions.create({ agentId: "life", title: "导出测试" });
    sessions.addMessage(s.id, { role: "user", content: "你好" });
    sessions.addMessage(s.id, { role: "assistant", content: "你好呀" });
    let r = await app.request(`/api/sessions/${s.id}/export?format=md`);
    expect(r.headers.get("content-type")).toContain("text/markdown");
    const md = await r.text();
    expect(md).toContain("# 导出测试");
    expect(md).toContain("👤 用户");
    expect(md).toContain("你好呀");
    r = await app.request(`/api/sessions/${s.id}/export?format=json`);
    const j = await r.json() as any;
    expect(j.session.title).toBe("导出测试");
    expect(j.messages.length).toBe(2);
    expect((await app.request("/api/sessions/nope/export")).status).toBe(404);
  });
});

describe("预算护栏", () => {
  it("block 模式当日超支 → 429 拒收新消息", async () => {
    const { deps, sessions } = stub({ budget: { dailyUsd: 1, mode: "block" } });
    const app = createApp(deps);
    const s = sessions.create({ agentId: "life" });
    const db = getDatabase();
    db.prepare("INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(s.id, "t/m", 10, 2, 12, 1.5, Date.now());
    const r = await app.request(`/api/sessions/${s.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(429);
    expect(((await r.json() as any).error)).toContain("预算护栏");
  });
});
