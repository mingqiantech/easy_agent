import { z } from "zod";
export const ConfigSchema = z.object({
  defaultModel: z.string().default("openai/qwen3.8-flash"),
  providers: z
    .record(z.object({ apiKey: z.string(), baseUrl: z.string().optional() }))
    .default({}),
  stateDir: z.string().default(""),
  workspaceDir: z.string().default("."),
  // Week 6: 渠道配置（可选）
  telegram: z
    .object({
      botToken: z.string().default(""),
      allowedUserIds: z.array(z.number()).default([]),
    })
    .optional(),
  discord: z
    .object({
      botToken: z.string().default(""),
      applicationId: z.string().default(""),
      allowedUserIds: z.array(z.string()).default([]),
    })
    .optional(),
  visionModel: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
