import fs from "node:fs/promises";
import path from "node:path";
import { parseManifestFromPackage } from "./manifest.js";
import type { PluginManifest } from "./manifest.js";

export interface InstalledPlugin {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  path: string;
  manifest: PluginManifest;
}

/**
 * 插件市场 Registry（Week 8 Step 1）
 * 扫描 plugins/ 目录，用 .enabled 标记文件控制启停，
 * install 走 bun add，uninstall 删除目录。
 */
export class PluginRegistry {
  private plugins = new Map<string, InstalledPlugin>();

  constructor(private pluginsDir: string) {}

  async scan(): Promise<InstalledPlugin[]> {
    this.plugins.clear();
    try {
      const entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const installed = await this.loadPlugin(path.join(this.pluginsDir, entry.name));
        if (installed) this.plugins.set(installed.name, installed);
      }
    } catch {
      // plugins 目录不存在 → 空列表
    }
    return this.list();
  }

  list(): InstalledPlugin[] {
    return Array.from(this.plugins.values());
  }

  get(name: string): InstalledPlugin | undefined {
    return this.plugins.get(name);
  }

  async enable(name: string): Promise<void> {
    const plugin = this.require(name);
    await fs.writeFile(path.join(plugin.path, ".enabled"), "");
    plugin.enabled = true;
  }

  async disable(name: string): Promise<void> {
    const plugin = this.require(name);
    try {
      await fs.unlink(path.join(plugin.path, ".enabled"));
    } catch {
      // 本来就没启用
    }
    plugin.enabled = false;
  }

  /** 从 npm 安装插件到 plugins/ 目录 */
  async install(pkgName: string): Promise<void> {
    if (!/^[@a-zA-Z0-9][a-zA-Z0-9@/._-]*$/.test(pkgName)) {
      throw new Error(`Invalid package name: ${pkgName}`);
    }
    await fs.mkdir(this.pluginsDir, { recursive: true });
    const pj = path.join(this.pluginsDir, "package.json");
    try {
      await fs.access(pj);
    } catch {
      await fs.writeFile(
        pj,
        JSON.stringify({ name: "easy-agent-plugins", private: true }, null, 2) + "\n",
      );
    }

    const proc = Bun.spawn(["bun", "add", pkgName], {
      cwd: this.pluginsDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`bun add failed (${code}): ${err.slice(0, 300)}`);
    }
    await this.scan();
  }

  async uninstall(name: string): Promise<void> {
    const plugin = this.require(name);
    await fs.rm(plugin.path, { recursive: true, force: true });
    this.plugins.delete(name);
  }

  private require(name: string): InstalledPlugin {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);
    return plugin;
  }

  private async loadPlugin(dir: string): Promise<InstalledPlugin | null> {
    try {
      const pkg = JSON.parse(
        await fs.readFile(path.join(dir, "package.json"), "utf-8"),
      );
      const manifest = parseManifestFromPackage(pkg);
      let enabled = true;
      try {
        await fs.access(path.join(dir, ".enabled"));
      } catch {
        enabled = false;
      }
      return {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        enabled,
        path: dir,
        manifest,
      };
    } catch {
      return null;
    }
  }
}
