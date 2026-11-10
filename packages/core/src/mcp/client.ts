import { z } from "zod";
import type { ToolRegistry } from "../tool/registry.js";

/**
 * MCP 客户端侧（2026-11-10 elf 点单"都改"）：把外部 MCP server 的stdio 工具
 * 接入本进程工具表，命名 <srv>__<tool>。与 mcp/server.ts（我们对外暴露）互补。
 * 入参 schema 透传提示即可（zod passthrough 宽容收 JSON），单服务失败不影响其余。
 */
export async function connectMcpServers(
  tools: ToolRegistry,
  servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  for (const [srv, sc] of Object.entries(servers)) {
    try {
      const transport = new StdioClientTransport({
        command: sc.command,
        args: sc.args ?? [],
        env: {
          ...(process.env as Record<string, string>),
          ...(sc.env ?? {}),
        } as Record<string, string>,
      });
      const client = new Client({ name: "easy-agent-gateway", version: "0.1.0" });
      await client.connect(transport);
      const { tools: mcpTools } = await client.listTools();
      for (const t of mcpTools) {
        tools.register({
          name: `${srv}__${t.name}`.replace(/[^\w-]/g, "_").slice(0, 60),
          description: `[MCP:${srv}] ${t.description || t.name}｜入参按该 MCP 工具的 JSON schema 传对象`,
          inputSchema: z.object({}).passthrough(),
          async execute(input: any) {
            const r: any = await client.callTool({ name: t.name, arguments: input ?? {} });
            const txt = (r?.content ?? [])
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
            return r?.isError ? { error: txt || JSON.stringify(r) } : { result: txt || r };
          },
        } as any);
      }
      log(`🔌 MCP "${srv}" 接入 ${mcpTools.length} 个工具`);
    } catch (e: any) {
      console.warn(`🔌 MCP "${srv}" 接入失败:`, String(e?.message).slice(0, 160));
    }
  }
}
