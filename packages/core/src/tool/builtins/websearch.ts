import { z } from "zod";
import type { Tool } from "../types.js";

/** Bing 搜索页抓取，无需 API key（DDG 在国内网络不可达，实测用 cn.bing.com）。 */
export const websearchTool: Tool = {
  name: "websearch",
  description: "网页搜索（Bing，免密钥）。返回标题/URL/摘要列表。超时 15s。",
  inputSchema: z.object({
    query: z.string().describe("搜索关键词"),
    count: z.number().optional().describe("结果条数（默认 8，最多 20）"),
  }),
  async execute(input: any) {
    const count = Math.min(Math.max(input.count ?? 8, 1), 20);
    try {
      const res = await fetch(
        "https://cn.bing.com/search?q=" + encodeURIComponent(input.query),
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!res.ok) return { error: `HTTP ${res.status}`, query: input.query };
      const html = await res.text();
      const blocks = html
        .split('<li class="b_algo"')
        .slice(1)
        .map((b) => b.split("</li>")[0]);
      const results: { title: string; url: string; snippet: string }[] = [];
      for (const b of blocks) {
        const link = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
          b,
        );
        if (!link) continue;
        const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(
          b.slice(b.indexOf("</h2>")),
        );
        results.push({
          title: stripTags(link[2]).trim(),
          url: link[1],
          snippet: snip ? stripTags(snip[1]).trim() : "",
        });
        if (results.length >= count) break;
      }
      if (results.length === 0)
        return { query: input.query, results: [], note: "无结果或被限流" };
      return { query: input.query, results };
    } catch (e: any) {
      return { error: e.message, query: input.query };
    }
  },
};

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&ensp;|&emsp;/g, " ")
    .replace(/&#0183;|&middot;/g, "·")
    .replace(/&nbsp;/g, " ");
}
