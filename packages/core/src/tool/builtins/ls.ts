import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import type { Tool, ToolContext } from "../types.js";

export const lsTool: Tool = {
  name: "ls",
  description:
    "列出目录内容（默认工作目录）。返回名称、类型、大小；按修改时间倒序，最多 200 项。",
  inputSchema: z.object({
    path: z.string().optional().describe("目录路径（相对或绝对，默认 workDir）"),
    sort: z
      .enum(["time", "name", "size"])
      .optional()
      .describe("排序方式（默认 time）"),
  }),
  async execute(input: any, ctx: ToolContext) {
    const dir = input.path ? path.resolve(ctx.workDir, input.path) : ctx.workDir;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      return { error: `无法读取目录 ${dir}: ${e.message}` };
    }
    const items = await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.stat(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          /* broken symlink etc. */
        }
        return {
          name: e.isDirectory() ? e.name + "/" : e.name,
          type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file",
          size: e.isDirectory() ? undefined : size,
          mtime: mtime ? new Date(mtime).toISOString() : undefined,
        };
      }),
    );
    const sort = input.sort ?? "time";
    items.sort((a: any, b: any) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (b.type === "dir" && a.type !== "dir") return 1;
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "size") return (b.size ?? 0) - (a.size ?? 0);
      return (b.mtime ?? "").localeCompare(a.mtime ?? "");
    });
    const truncated = items.length > 200;
    return { dir, count: items.length, entries: items.slice(0, 200), truncated };
  },
};
