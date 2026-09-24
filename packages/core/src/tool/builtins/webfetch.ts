import { z } from "zod";
import type { Tool } from "../types.js";

export const webfetchTool: Tool = {
  name: "webfetch",
  description: "获取 URL 内容。超时 15s。",
  inputSchema: z.object({
    url: z.string().describe("HTTP(S) URL"),
    maxChars: z.number().optional().describe("最大字符数（默认 20000）"),
  }),
  async execute(input: any) {
    const max = input.maxChars ?? 20000;
    try {
      const res = await fetch(input.url, {
        headers: { "User-Agent": "MyAgent/0.2" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { error: `HTTP ${res.status}`, url: input.url };
      let text = await res.text();
      if (text.length > max) text = text.slice(0, max) + "\n...[truncated]";
      return { url: input.url, status: res.status, content: text };
    } catch (e: any) {
      return { error: e.message, url: input.url };
    }
  },
};
