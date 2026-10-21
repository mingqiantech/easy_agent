import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickPermissionOption, createAcpAgentTool } from "../../src/tool/builtins/acp-agent.js";

describe("pickPermissionOption 策略选路", () => {
  const opts = [
    { optionId: "o1", name: "Allow once", kind: "allow_once" },
    { optionId: "o2", name: "Allow always", kind: "allow_always" },
    { optionId: "o3", name: "Reject", kind: "reject_once" },
  ];
  it("autoApprove → 优先 allow_once", () => expect(pickPermissionOption(opts, true)).toBe("o1"));
  it("拒绝模式 → reject_once", () => expect(pickPermissionOption(opts, false)).toBe("o3"));
  it("无 kind 时按名字模糊匹配", () =>
    expect(pickPermissionOption([{ optionId: "x", name: "Yes allow" }], true)).toBe("x"));
  it("空表返回 undefined", () => expect(pickPermissionOption([], true)).toBeUndefined());
});

/* 假 ACP 服务器：NDJSON，支持 initialize/session/new/prompt，主动发 permission 请求与 update */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fake-"));
const fakeServer = path.join(tmp, "fake_acp.ts");
fs.writeFileSync(
  fakeServer,
  [
    'const rd = (await import("node:readline")).createInterface({ input: process.stdin });',
    'const send = (o: any) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let n = 0;',
    'for await (const line of rd) {',
    '  let m: any; try { m = JSON.parse(line); } catch { continue; }',
    '  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });',
    '  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "fake-sess-1" } });',
    '  else if (m.method === "session/prompt") {',
    '    n++;',
    '    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-sess-1", update: { sessionUpdate: "tool_call", title: "Bash echo" } } });',
    '    send({ jsonrpc: "2.0", id: 900 + n, method: "session/request_permission", params: { sessionId: "fake-sess-1", options: [{ optionId: "ap", kind: "allow_once" }, { optionId: "rj", kind: "reject_once" }] } });',
    '    const wait = new Promise<void>((r) => {',
    '      const on = (l2: string) => { const j = JSON.parse(l2); if (j.id === 900 + n) { rd.off("line", on); r(); } };',
    '      rd.on("line", on);',
    '    });',
    '    await wait;',
    '    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-sess-1", update: { sessionUpdate: "agent_message_chunk", content: { text: `回合${n}完成 ` } } } });',
    '    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });',
    '  }',
    '}',
  ].join("\n"),
);

describe("acp_agent 工具（假服务器端到端）", () => {
  const tool = createAcpAgentTool({
    agents: { fake: { bin: process.execPath, args: [fakeServer] } }, // process.execPath = bun
    timeoutMinutes: 1,
    allowedWorkdirs: [tmp],
  });
  const ctx: any = { sessionId: "s", agentId: "default", workDir: tmp };

  it("首轮：建会话→权限自动应答→收文返 result", async () => {
    const r: any = await tool.execute({ prompt: "跑一下" }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.result).toContain("回合1完成");
    expect(r.sessionId).toBe("fake-sess-1");
    expect(r.stopReason).toBe("end_turn");
    expect(r.toolActivity).toEqual(["Bash echo"]);
  });

  it("二轮同 workdir：复用池内会话（上下文在 agent 侧累计）", async () => {
    const r: any = await tool.execute({ prompt: "再来" }, ctx);
    expect(r.result).toContain("回合2完成"); // 假服务器计数证明是同进程同会话
  });

  it("workdir 围栏外拒绝", async () => {
    const r: any = await tool.execute({ prompt: "x", workdir: "/etc" }, ctx);
    expect(r.error).toContain("不在允许列表");
  });

  it("未知 agent 名报错并列出可选", async () => {
    const r: any = await tool.execute({ prompt: "x", agent: "nope" }, ctx);
    expect(r.error).toContain("fake");
  });
});
