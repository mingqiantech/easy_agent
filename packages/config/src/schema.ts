import { z } from "zod";
export const ConfigSchema = z.object({
  defaultModel: z.string().default("openai/glm-5.3"),
  providers: z
    .record(z.object({ apiKey: z.string(), baseUrl: z.string().optional() }))
    .default({}),
  stateDir: z.string().default(""),
  workspaceDir: z.string().default("."),
});
export type Config = z.infer<typeof ConfigSchema>;
