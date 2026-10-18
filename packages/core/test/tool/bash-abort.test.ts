import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../src/tool/registry.js";
import { bashTool } from "../../src/tool/builtins/bash.js";

describe("bash abortSignal（子进程随中断终止）", () => {
  it("abort 后 sleep 子进程立即被杀", async () => {
    const reg = new ToolRegistry();
    reg.register(bashTool);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const t0 = Date.now();
    const r = await reg.execute(
      "bash",
      { command: "sleep 5" },
      { sessionId: "t", agentId: "t", workDir: "/tmp", abortSignal: ctrl.signal },
    );
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(3000); // 远小于 sleep 5
    expect((r.output as any)?.aborted).toBe(true);
  });

  it("正常执行不带 aborted 标记", async () => {
    const reg = new ToolRegistry();
    reg.register(bashTool);
    const r = await reg.execute(
      "bash",
      { command: "echo hi" },
      { sessionId: "t", agentId: "t", workDir: "/tmp" },
    );
    expect((r.output as any)?.aborted).toBeFalsy();
    expect((r.output as any)?.stdout).toBe("hi");
  });
});
