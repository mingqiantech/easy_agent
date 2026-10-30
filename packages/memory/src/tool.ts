import { z } from "zod";
import type { Tool, ToolContext } from "@easy-agent/core/tool/types";
import type { MemorySearcher } from "./search.js";
import type { HybridSearch } from "./hybrid-search.js";

export interface MemorySearchToolOpts {
  /** 混合检索（向量+全文）；缺省时退化为纯关键词 */
  hybrid?: HybridSearch;
  /** corpus 到 hybrid source 的映射参数 */
  weights?: { vectorWeight?: number; textWeight?: number };
  /** 检索状态回调（mode/命中数展示用） */
  onStatus?: (s: { mode: string; hits: number }) => void;
  /**
   * 多工作区隔离（2026-10-30）：按 ctx.workDir 解析该 agent 的检索资源。
   * 提供时优先于顶层 searcher/hybrid（每次 execute 现取）。
   */
  forWorkDir?: (workDir: string) => { searcher: MemorySearcher; hybrid?: HybridSearch };
}

export function createMemorySearchTool(
  searcher: MemorySearcher,
  opts: MemorySearchToolOpts = {},
): Tool {
  return {
    name: "memory_search",
    description: `语义搜索 MEMORY.md、USER.md、memory/ 下的文件和会话历史。
在回答关于之前的工作、决策、日期、人物、偏好的问题前必须调用。
支持中文（自动切词）；配置了向量检索时按 语义+关键词 混合排序（结果 mode 字段标明）。`,
    inputSchema: z.object({
      query: z.string().describe("搜索查询"),
      maxResults: z.number().optional().describe("最大结果数"),
      corpus: z.enum(["memory", "sessions", "all"]).optional(),
    }),
    async execute(input: any, ctx: ToolContext) {
      // 分发：本 agent 工作区的资源（无 forWorkDir 时回退顶层单例，单测/旧链路兼容）
      const res = opts.forWorkDir?.(ctx.workDir) ?? { searcher, hybrid: opts.hybrid };
      const hybrid = res.hybrid;
      const corpus = input.corpus ?? "all";
      if (hybrid && corpus !== "all") {
        const r = await hybrid.search(input.query, {
          limit: input.maxResults,
          source: corpus === "sessions" ? "session" : "memory",
          vectorWeight: opts.weights?.vectorWeight,
          textWeight: opts.weights?.textWeight,
        });
        opts.onStatus?.({ mode: r.mode, hits: r.hits.length });
        return { mode: r.mode, hits: r.hits };
      }
      if (hybrid && corpus === "all") {
        // all：两通道各查一次再合
        const [m, s] = await Promise.all([
          hybrid.search(input.query, {
            limit: input.maxResults,
            source: "memory",
            vectorWeight: opts.weights?.vectorWeight,
            textWeight: opts.weights?.textWeight,
          }),
          hybrid.search(input.query, {
            limit: input.maxResults,
            source: "session",
            vectorWeight: opts.weights?.vectorWeight,
            textWeight: opts.weights?.textWeight,
          }),
        ]);
        const merged = [...m.hits, ...s.hits]
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .slice(0, input.maxResults ?? 10);
        const mode = m.mode === "hybrid" || s.mode === "hybrid" ? "hybrid" : "text-only";
        opts.onStatus?.({ mode, hits: merged.length });
        return { mode, hits: merged };
      }
      const r = await searcher.search(input.query, {
        maxResults: input.maxResults,
        corpus,
      });
      opts.onStatus?.({ mode: "text-only", hits: r.hits.length });
      return r;
    },
  };
}
