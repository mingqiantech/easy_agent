import { z } from "zod";
export interface ToolContext {
  sessionId: string;
  agentId: string;
  workDir: string;
  abortSignal?: AbortSignal;
}
export interface ToolResult {
  output: unknown;
  error?: string;
  truncated?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** 透传 zod schema（ai-sdk v4 要求）；自行序列化成 JSON 时用 zodToJsonSchema */
  inputSchema: unknown;
}
export interface Tool<TInput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolContext): Promise<unknown>;
}
