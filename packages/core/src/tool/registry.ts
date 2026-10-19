import type { Tool, ToolContext, ToolResult, ToolDefinition } from "./types.js";
import { readTool } from "./builtins/read.js";
import { writeTool } from "./builtins/write.js";
import { editTool } from "./builtins/edit.js";
import { bashTool } from "./builtins/bash.js";
import { globTool } from "./builtins/glob.js";
import { grepTool } from "./builtins/grep.js";
import { webfetchTool } from "./builtins/webfetch.js";
import { memoryGetTool } from "./builtins/memory-get.js";
import { gitTool } from "./builtins/git.js";
import { extractTool } from "./builtins/extract.js";
import { lsTool } from "./builtins/ls.js";
import { websearchTool } from "./builtins/websearch.js";
import { todoTool } from "./builtins/todo.js";
import { zodToJsonSchema } from "./schema-utils.js";

const BUILTINS = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  webfetchTool,
  memoryGetTool,
  gitTool,
  extractTool,
  lsTool,
  websearchTool,
  todoTool,
];
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(registerBuiltins = true) {
    if (registerBuiltins) BUILTINS.forEach((t) => this.register(t));
  }

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string) {
    this.tools.delete(name);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  getDefinitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool)
      return {
        output: null,
        error: `Unknown tool: "${name}".Available:${this.names().join(", ")}`,
      };
    try {
      const validated = tool.inputSchema.parse(input);
      const output = await tool.execute(validated, ctx);
      const s = JSON.stringify(output);
      if (s.length > 50 * 1024)
        return {
          output: s.slice(0, 50 * 1024) + "...[truncated]",
          truncated: true,
        };
      return { output };
    } catch (e: any) {
      if (e.name === "ZodError")
        return { output: null, error: `Invalid input: ${e.message}` };
      return { output: null, error: e.message };
    }
  }

  /** 生成可读工具清单 markdown（供 TOOLS.md 自动落盘） */
  toMarkdown(): string {
    const lines = [
      "# TOOLS.md - 工具清单（自动生成，勿手改）",
      "",
      `> 由 ToolRegistry 在网关启动时生成，共 ${this.tools.size} 个工具。`,
      "",
    ];
    for (const t of this.list()) {
      lines.push(`## ${t.name}`, "", t.description, "");
      try {
        const schema = zodToJsonSchema(t.inputSchema as any);
        lines.push("```json", JSON.stringify(schema, null, 2), "```", "");
      } catch {
        /* schema 转不动就只列名字+描述 */
      }
    }
    return lines.join("\n");
  }
}
