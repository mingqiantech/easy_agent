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
  inputSchema: unknown;
}
export interface Tool<TInput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, context: ToolContext): Promise<unknown>;
}
