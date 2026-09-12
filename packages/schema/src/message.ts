import { z } from "zod";

export const MessageRole = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "function",
]);
export type MessageRole = z.infer<typeof MessageRole>;

export const Message = z.object({
  role: MessageRole,
  content: z.string(),
  id: z.string().optional(),
  createdAt: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});
export type Message = z.infer<typeof Message>;

export function userMessage(content: string): Message {
  return { role: "user", content };
}

export function assistantMessage(content: string): Message {
  return { role: "assistant", content };
}

export function systemMessage(content: string): Message {
  return { role: "system", content };
}
export function toolMessage(content: string): Message {
  return { role: "tool", content };
}
export function functionMessage(content: string): Message {
  return { role: "function", content };
}
