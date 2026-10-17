import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolRegistry } from "../tool/registry.js";

/**
 * MCP Server（Week 10）
 * 把 easy-agent 的工具集暴露为 MCP server，供 Claude Desktop 等外部宿主调用。
 */
export function createMCPServer(tools: ToolRegistry): Server {
  const server = new Server(
    { name: "easy-agent", version: "0.10.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.getDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: "object" }) as any,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await tools.execute(name, args ?? {}, {
      sessionId: "mcp",
      agentId: "mcp",
      workDir: process.cwd(),
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.output ?? result.error, null, 2),
        },
      ],
      isError: !!result.error,
    };
  });

  return server;
}

/** 以 stdio 传输启动（供 MCP 宿主以子进程方式拉起） */
export async function startMCPServer(tools: ToolRegistry): Promise<void> {
  const server = createMCPServer(tools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✓ MCP server started (stdio)");
}

/**
 * 生成 Claude Desktop 配置片段（供 README / CLI 提示用）
 */
export function mcpClientConfigSnippet(repoRoot: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        "easy-agent": {
          command: "bun",
          args: ["run", path.join(repoRoot, "packages/cli/src/entry.ts"), "mcp", "serve"],
        },
      },
    },
    null,
    2,
  );
}

// 保留 fs 引用以便未来暴露 resources 能力
void fs;
