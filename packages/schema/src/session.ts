import { z } from "zod";

export const SessionInfo = z.object({
  id: z.string(),
  title: z.string().nullable(),
  agentId: z.string(),
  model: z.string(),
  status: z.enum(["active", "archived", "deleted"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number().default(0),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const CreateSessionInput = z.object({
  model: z.string().optional(),
  agentId: z.string().default("default"),
  systemPrompt: z.string().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInput>;
