import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../src/tool/registry.js";

describe("ToolRegistry", () => {
  it("registers builtin tools", () => {
    const reg = new ToolRegistry(true);
    expect(reg.names()).toContain("read");
    expect(reg.names()).toContain("write");
    expect(reg.names()).toContain("bash");
    expect(reg.names()).toContain("memory_get");
  });

  it("generates definitions", () => {
    const reg = new ToolRegistry(true);
    const defs = reg.getDefinitions();
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0]).toHaveProperty("name");
    expect(defs[0]).toHaveProperty("description");
    expect(defs[0]).toHaveProperty("inputSchema");
  });

  it("returns error for unknown tool", async () => {
    const reg = new ToolRegistry(true);
    const result = await reg.execute(
      "nonexistent",
      {},
      { sessionId: "t", agentId: "t", workDir: "/tmp" },
    );
    expect(result.error).toContain("Unknown tool");
  });
});
