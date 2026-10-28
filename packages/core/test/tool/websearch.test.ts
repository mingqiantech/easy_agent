import { describe, it, expect } from "bun:test";
import { createWebsearchTool } from "../../src/tool/builtins/websearch.js";

const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: any) => Promise<any>) {
  (globalThis as any).fetch = async (url: any, init?: any) => handler(String(url), init);
}
const restore = () => ((globalThis as any).fetch = realFetch);

const jsonResp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("websearch ollama provider", () => {
  it("auto 无 key → 选 ollama；本地代理路径 + body 正确", async () => {
    let seenUrl = "";
    let seenBody: any = null;
    mockFetch(async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return jsonResp({
        results: [
          { title: "T1", url: "https://a.com", content: "摘要一" },
          { title: "T2", url: "https://b.com", content: "摘要二" },
        ],
      });
    });
    const tool = createWebsearchTool({ ollamaBaseUrl: "http://172.18.32.1:11434" });
    const out: any = await tool.execute({ query: "比亚迪 保养", count: 3 }, {} as any);
    restore();
    expect(out.provider).toBe("ollama");
    expect(seenUrl).toBe("http://172.18.32.1:11434/api/experimental/web_search");
    expect(seenBody).toEqual({ query: "比亚迪 保养", max_results: 3 });
    expect(out.results.length).toBe(2);
    expect(out.results[0].snippet).toBe("摘要一");
  });

  it("ollama 401 且无云 key → 回退 Bing 抓取", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("web_search")) return jsonResp({ error: "unauthorized" }, 401);
      // bing 假 HTML
      return new Response(
        '<li class="b_algo"><h2><a href="https://x.com">标题X</a></h2><p>片段X</p></li>',
        { status: 200 },
      );
    });
    const tool = createWebsearchTool({
      provider: "ollama",
      ollamaBaseUrl: "http://127.0.0.1:1",
    });
    const out: any = await tool.execute({ query: "q" }, {} as any);
    restore();
    expect(out.provider).toBe("bing (fallback)");
    expect(out.results[0].url).toBe("https://x.com");
    expect(out.note).toContain("ollama 失败");
  });

  it("ollama 失败且有云 key → 先试 ollama.com 云直连", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      if (String(url).startsWith("http://127.0.0.1:1"))
        return jsonResp({ error: "down" }, 500);
      return jsonResp({ results: [{ title: "C", url: "https://c.com", content: "云" }] });
    });
    const tool = createWebsearchTool({
      provider: "ollama",
      ollamaBaseUrl: "http://127.0.0.1:1",
      ollamaApiKey: "***",
    });
    const out: any = await tool.execute({ query: "q" }, {} as any);
    restore();
    expect(out.provider).toBe("ollama (cloud)");
    expect(urls.some((u) => u.includes("ollama.com/api/web_search"))).toBe(true);
  });

  it("ollama 空结果（无 results）→ 回退 Bing", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("web_search")) return jsonResp({ results: [] });
      return new Response(
        '<li class="b_algo"><h2><a href="https://y.com">Y</a></h2><p>YIP</p></li>',
        { status: 200 },
      );
    });
    const tool = createWebsearchTool({ provider: "ollama" });
    const out: any = await tool.execute({ query: "q" }, {} as any);
    restore();
    expect(out.provider).toBe("bing (fallback)");
  });
});
