import { z } from "zod";
import type { Tool } from "../types.js";

/**
 * 网页搜索工具：provider 可配置。
 * - 配置了 tavily/brave/bocha 任一 key → 用对应 API（auto 按 tavily>brave>bocha 优先级）
 * - 都没配置 / API 失败 → 回退 Bing 抓取（cn.bing.com，免密钥，原实现保留）
 */
export interface WebsearchConfig {
  provider?: "auto" | "tavily" | "brave" | "bocha" | "bing";
  tavilyApiKey?: string;
  braveApiKey?: string;
  bochaApiKey?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function createWebsearchTool(cfg: WebsearchConfig = {}): Tool {
  const pick = () => {
    const p = cfg.provider ?? "auto";
    if (p !== "auto") return p;
    if (cfg.tavilyApiKey) return "tavily" as const;
    if (cfg.braveApiKey) return "brave" as const;
    if (cfg.bochaApiKey) return "bocha" as const;
    return "bing" as const;
  };

  const tool: Tool = {
    name: "websearch",
    description:
      "网页搜索。返回标题/URL/摘要列表。超时 15s。后端取决于配置（Tavily/Brave/Bocha API，或免密钥 Bing 抓取）。",
    inputSchema: z.object({
      query: z.string().describe("搜索关键词"),
      count: z.number().optional().describe("结果条数（默认 8，最多 20）"),
    }),
    async execute(input: any) {
      const count = Math.min(Math.max(input.count ?? 8, 1), 20);
      const q = input.query;
      const primary = pick();
      try {
        let results: SearchResult[] | null = null;
        if (primary === "tavily") results = await tavilySearch(q, count, cfg.tavilyApiKey!);
        else if (primary === "brave") results = await braveSearch(q, count, cfg.braveApiKey!);
        else if (primary === "bocha") results = await bochaSearch(q, count, cfg.bochaApiKey!);
        else results = await bingSearch(q, count);
        if (results) return { query: q, provider: primary, results };
        throw new Error("empty");
      } catch (e: any) {
        if (primary === "bing") return { error: e?.message, query: q };
        // API 失败 → 回退 Bing 抓取
        try {
          const fallback = await bingSearch(q, count);
          if (fallback)
            return {
              query: q,
              provider: "bing (fallback)",
              note: `${primary} 失败：${String(e?.message).slice(0, 100)}`,
              results: fallback,
            };
        } catch {}
        return { error: e?.message, query: q, provider: primary };
      }
    },
  };
  return tool;
}

/** 默认实例（无配置 = Bing 抓取） */
export const websearchTool = createWebsearchTool();

/* ── Tavily（agent 专用搜索 API） ── */
async function tavilySearch(
  query: string,
  count: number,
  key: string,
): Promise<SearchResult[] | null> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data: any = await res.json();
  return (data.results ?? []).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: (r.content ?? "").slice(0, 300),
  }));
}

/* ── Brave Search API ── */
async function braveSearch(
  query: string,
  count: number,
  key: string,
): Promise<SearchResult[] | null> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { "X-Subscription-Token": key, Accept: "application/json" }, signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data: any = await res.json();
  return (data.web?.results ?? []).map((r: any) => ({
    title: stripTags(r.title ?? ""),
    url: r.url ?? "",
    snippet: stripTags(r.description ?? ""),
  }));
}

/* ── 博查 Bocha（中文搜索） ── */
async function bochaSearch(
  query: string,
  count: number,
  key: string,
): Promise<SearchResult[] | null> {
  const res = await fetch(
    "https://api.bochaai.com/v1/web-search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, count, summary: true }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`Bocha HTTP ${res.status}`);
  const data: any = await res.json();
  const pages = data?.data?.webPages?.value ?? [];
  return pages.map((r: any) => ({
    title: r.name ?? "",
    url: r.url ?? "",
    snippet: r.summary ?? r.snippet ?? "",
  }));
}

/* ── Bing 抓取（保留原实现，免密钥回退） ── */
async function bingSearch(
  query: string,
  count: number,
): Promise<SearchResult[] | null> {
  const res = await fetch(
    "https://cn.bing.com/search?q=" + encodeURIComponent(query),
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const blocks = html
    .split('<li class="b_algo"')
    .slice(1)
    .map((b) => b.split("</li>")[0]);
  const results: SearchResult[] = [];
  for (const b of blocks) {
    const link = /<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!link) continue;
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(b.slice(b.indexOf("</h2>")));
    results.push({
      title: stripTags(link[2]).trim(),
      url: link[1],
      snippet: snip ? stripTags(snip[1]).trim() : "",
    });
    if (results.length >= count) break;
  }
  return results.length ? results : null;
}

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
