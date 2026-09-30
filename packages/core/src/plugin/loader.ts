import path from "node:path";
import fs from "node:fs/promises";
import type { Plugin, PluginApi } from "./types.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { CronManager } from "../cron/index.js";

export class PluginLoader {
  private plugins = new Map<string, Plugin>();

  constructor(
    private toolRegistry: ToolRegistry,
    private cronManager: CronManager,
  ) {}

  async loadFromDirectory(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(dir, entry.name);
        try {
          const pkg = JSON.parse(
            await fs.readFile(path.join(pluginDir, "package.json"), "utf-8"),
          );
          const mainPath = path.join(pluginDir, pkg.main ?? "index.ts");
          const mod = await import(mainPath);
          const plugin: Plugin = mod.default ?? mod;
          if (plugin.name) this.plugins.set(plugin.name, plugin);
        } catch (e: any) {
          console.warn(`Failed to load plugin ${entry.name}: ${e.message}`);
        }
      }
    } catch {}
  }

  async initializeAll(): Promise<void> {
    const api = this.createApi();
    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.onLoad?.(api);
        if (plugin.registerTools) {
          for (const tool of plugin.registerTools(api))
            this.toolRegistry.register(tool);
        }
        console.log(`✓ Plugin: ${name} v${plugin.version}`);
      } catch (e: any) {
        console.error(`✗ Plugin ${name}: ${e.message}`);
      }
    }
  }

  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  private createApi(): PluginApi {
    return {
      registerTool: (tool) => this.toolRegistry.register(tool),
      registerCronJob: (job) => this.cronManager.create(job),
      getConfig: () => ({}),
      getLogger: () => ({
        info: (...args) => console.log("[plugin]", ...args),
        warn: (...args) => console.warn("[plugin]", ...args),
        error: (...args) => console.error("[plugin]", ...args),
      }),
    };
  }
}
