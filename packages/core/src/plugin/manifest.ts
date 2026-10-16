import { z } from "zod";

/**
 * 插件清单 Schema（Week 8 插件市场）
 * 每个插件目录的 package.json 需符合此结构。
 */
export const PluginManifest = z.object({
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().default(""),
  main: z.string().default("index.ts"),
  capabilities: z
    .object({
      tools: z.array(z.string()).default([]),
      commands: z.array(z.string()).default([]),
    })
    .default({ tools: [], commands: [] }),
  permissions: z
    .object({
      network: z.boolean().default(false),
      subprocess: z.boolean().default(false),
      fileSystem: z.boolean().default(false),
    })
    .default({ network: false, subprocess: false, fileSystem: false }),
});

export type PluginManifest = z.infer<typeof PluginManifest>;

/** 从 package.json 对象解析清单（忽略无关字段） */
export function parseManifestFromPackage(pkg: Record<string, unknown>): PluginManifest {
  return PluginManifest.parse({
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    capabilities: pkg.capabilities,
    permissions: pkg.permissions,
  });
}
