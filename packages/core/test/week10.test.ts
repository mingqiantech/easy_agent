import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-w10-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "../src/database.js";
import { extractTool } from "../src/tool/builtins/extract.js";
import { createMCPServer, mcpClientConfigSnippet } from "../src/mcp/server.js";
import { ToolRegistry } from "../src/tool/registry.js";
import { zodToJsonSchema } from "../src/tool/schema-utils.js";

beforeAll(() => {
  getDatabase(process.env.EASY_AGENT_DB_PATH!);
});

const ctx = { sessionId: "t", agentId: "t", workDir: TEST_DIR };

function writeFixture(name: string, content: string): string {
  const p = path.join(TEST_DIR, name);
  fs.writeFileSync(p, content);
  return name;
}

describe("Week10: extract tool", () => {
  it("reads markdown/plain text", async () => {
    const file = writeFixture("notes.md", "# Title\n\ncontent here");
    const r = (await extractTool.execute({ path: file }, ctx)) as any;
    expect(r.text).toContain("Title");
    expect(r.truncated).toBe(false);
  });

  it("pretty-prints json", async () => {
    const file = writeFixture("data.json", '{"a":1}');
    const r = (await extractTool.execute({ path: file }, ctx)) as any;
    expect(r.text).toContain('"a": 1');
  });

  it("strips html tags and scripts", async () => {
    const file = writeFixture(
      "page.html",
      "<html><script>var x=1</script><style>p{}</style><body><h1>Hello</h1><p>World &amp; friends</p></body></html>",
    );
    const r = (await extractTool.execute({ path: file }, ctx)) as any;
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("World & friends");
    expect(r.text).not.toContain("var x=1");
    expect(r.text).not.toContain("<h1>");
  });

  it("honors maxChars truncation", async () => {
    const file = writeFixture("long.txt", "x".repeat(1000));
    const r = (await extractTool.execute({ path: file, maxChars: 100 }, ctx)) as any;
    expect(r.text.length).toBeLessThanOrEqual(120);
    expect(r.truncated).toBe(true);
    expect(r.chars).toBe(1000);
  });

  it("reports missing optional deps without crashing", async () => {
    const fake = path.join(TEST_DIR, "doc.pdf");
    fs.writeFileSync(fake, "%PDF-1.4 fake");
    const r = (await extractTool.execute({ path: "doc.pdf" }, ctx)) as any;
    // 未装 pdf-parse 时应给出安装提示，而不是抛出异常
    expect(r.error ?? r.text).toBeTruthy();
  });

  it("detects binary files", async () => {
    const fake = path.join(TEST_DIR, "blob.bin");
    fs.writeFileSync(fake, Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const r = (await extractTool.execute({ path: "blob.bin" }, ctx)) as any;
    expect(r.error).toContain("Binary");
  });

  it("returns error for missing file", async () => {
    const r = (await extractTool.execute({ path: "nope.md" }, ctx)) as any;
    expect(r.error).toContain("not found");
  });
});

describe("Week10: MCP server", () => {
  it("creates a server with tool capabilities", () => {
    const registry = new ToolRegistry(true);
    const server = createMCPServer(registry);
    expect(server).toBeDefined();
  });

  it("registry exposes extract tool via definitions", () => {
    const registry = new ToolRegistry(true);
    const defs = registry.getDefinitions();
    const extract = defs.find((d) => d.name === "extract");
    expect(extract).toBeDefined();
    expect(extract!.inputSchema).toBeDefined();
    expect(typeof extract!.description).toBe("string");
  });

  it("config snippet is valid JSON with command", () => {
    const snippet = mcpClientConfigSnippet("/repo");
    const parsed = JSON.parse(snippet);
    expect(parsed.mcpServers["easy-agent"].command).toBe("bun");
    expect(parsed.mcpServers["easy-agent"].args.join(" ")).toContain("mcp");
  });

  it("zodToJsonSchema keeps required fields accurate", () => {
    const registry = new ToolRegistry(true);
    const extract = registry.get("extract")!;
    const schema = zodToJsonSchema(extract.inputSchema) as any;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("path");
    expect(schema.properties.maxChars).toBeDefined();
  });
});
