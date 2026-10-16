import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PluginRegistry } from "../src/plugin/registry.js";

let dir: string;
let registry: PluginRegistry;

async function fakePlugin(name: string, extra?: Record<string, unknown>): Promise<string> {
  const pluginDir = path.join(dir, name);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      description: `${name} test plugin`,
      main: "index.ts",
      capabilities: { tools: [`${name}_tool`], commands: [] },
      permissions: { network: true, subprocess: false, fileSystem: false },
      ...extra,
    }),
  );
  return pluginDir;
}

describe("PluginRegistry", () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-plugins-"));
    registry = new PluginRegistry(dir);
  });

  it("scans plugins and defaults to disabled (no .enabled marker)", async () => {
    await fakePlugin("alpha");
    const list = await registry.scan();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("alpha");
    expect(list[0].enabled).toBe(false);
    expect(list[0].manifest.capabilities.tools).toEqual(["alpha_tool"]);
    expect(list[0].manifest.permissions.network).toBe(true);
  });

  it("enable/disable toggles the marker file", async () => {
    await fakePlugin("beta");
    await registry.scan();

    await registry.enable("beta");
    expect(registry.get("beta")!.enabled).toBe(true);
    expect(await Bun.file(path.join(dir, "beta", ".enabled")).exists()).toBe(true);

    await registry.disable("beta");
    expect(registry.get("beta")!.enabled).toBe(false);
  });

  it("enabled state persists across scans", async () => {
    await registry.enable("beta");
    const second = new PluginRegistry(dir);
    await second.scan();
    expect(second.get("beta")!.enabled).toBe(true);
  });

  it("ignores directories without valid package.json", async () => {
    await fs.mkdir(path.join(dir, "broken"), { recursive: true });
    const list = await registry.scan();
    expect(list.find((p) => p.name === "broken")).toBeUndefined();
  });

  it("uninstall removes the directory", async () => {
    await fakePlugin("gamma");
    await registry.scan();
    await registry.uninstall("gamma");
    expect(registry.get("gamma")).toBeUndefined();
    expect(await Bun.file(path.join(dir, "gamma", "package.json")).exists()).toBe(false);
  });

  it("operations on unknown plugins throw", async () => {
    expect(() => registry.get("nope")).not.toThrow();
    await expect(registry.enable("nope")).rejects.toThrow("not found");
    await expect(registry.install("bad name;rm")).rejects.toThrow("Invalid package name");
  });
});
