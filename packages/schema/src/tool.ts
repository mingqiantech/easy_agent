import { z } from "zod";

export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});

export type ToolDefinition = z.infer<typeof ToolDefinition>;

export const ToolCall = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  toolCallId: z.string(),
  output: z.unknown(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;
