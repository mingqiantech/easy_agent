import { describe, it, expect } from "bun:test";
import { ConfigSchema } from "../src/schema.js";
import { resolveAgents } from "../src/models.js";

describe("agent 专属工具黑名单（toolsDisable）", () => {
  const base = {
    providers: {}, models: { "p/m": {} },
    agents: {
      writer: { description: "写作", tools: { disable: ["trae_agent", "acp_agent"] } },
      coder: { description: "编码" },
    },
  } as any;
  it("配置 tools.disable → resolveAgents 透传 toolsDisable", () => {
    const cfg = ConfigSchema.parse(base);
    const rs = resolveAgents(cfg as any);
    const writer = rs.find((r) => r.name === "writer")!;
    const coder = rs.find((r) => r.name === "coder")!;
    expect(writer.toolsDisable).toEqual(["trae_agent", "acp_agent"]);
    expect(coder.toolsDisable).toEqual([]);
  });
  it("default agent 也支持（agents.default.tools.disable）", () => {
    const cfg = ConfigSchema.parse({ ...base, agents: { default: { tools: { disable: ["bash"] } } } } as any);
    const rs = resolveAgents(cfg as any);
    expect(rs[0]!.toolsDisable).toEqual(["bash"]);
  });
});
