import { z } from "zod";
export const ConfigSchema = z.object({
  defaultModel: z.string().default("openai/qwen3.8-flash"),
  providers: z
    .record(z.object({ apiKey: z.string(), baseUrl: z.string().optional() }))
    .default({}),
  stateDir: z.string().default(""),
  workspaceDir: z.string().default("."),
});
export type Config = z.infer<typeof ConfigSchema>;
