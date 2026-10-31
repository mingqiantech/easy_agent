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
  /**
   * 关联 agent 二次索引（2026-10-30 elf 点单）：按 ctx.agentId 取其配置的
   * relatedAgents 对应检索资源；主检索命中后提索引词去关联工作区二查，
   * 结果打 from 标签附在 hits 尾部。
   */
  resolveRelated?: (agentId?: string) => Array<{ name: string; searcher: MemorySearcher; hybrid?: HybridSearch }>;
}

/**
 * 从主检索命中的摘录提取"索引词"：CJK 连续串（2~8 字）+ 英文词（≥3 字母），
 * 过滤掉已在查询里的词，按出现频次降序取 top N。用作二次检索的钥匙。
 */
export function extractIndexTerms(excerpts: string[], query: string, max = 6): string[] {
  const freq = new Map<string, number>();
  // 查询自身切词（与提取同一把尺），用于双向包含过滤（"偏好" 要能拦下 "用户偏好使用"）
  const qTerms = (query.match(/[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9+.#-]{2,}/g) ?? [])
    .map((t) => (/[\u4e00-\u9fff]/.test(t) ? t : t.toLowerCase()));
  const inQuery = (t: string) => qTerms.some((q) => t.includes(q) || q.includes(t));
  for (const text of excerpts) {
    const chunks = text.match(/[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9+.#-]{2,}/g) ?? [];
    for (const raw of chunks) {
      const t = /[\u4e00-\u9fff]/.test(raw) ? raw : raw.toLowerCase();
      if (inQuery(t)) continue; // 查询已含的词不重复带路
      // 高频虚词/格式词不当钥匙
      if (/^(用户|决定|问题|相关|进行|使用|通过|当前|之后|之前|如果|可以|需要|内容|方案|markdown|http|https|www)$/.test(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    // 同频按首次出现序（Map 插入序 + sort 稳定性；去掉了 localeCompare——它会把 ASCII 词插队顶掉中文钥匙词）
    .sort((a, b) => b[1] - a[1])
    // 硬顶 6 把钥匙：二查词串太长会稀释另一侧工作区的相似度，max 参数只允许往下收
    .slice(0, Math.min(max, 6))
    .map(([t]) => t);
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
      const primary = await (async () => {
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
      return { mode: "text-only" as const, hits: r.hits ?? [] };
      })();

      // ── 关联 agent 二次索引：主命中 excerpt → 索引词 → 去关联工作区检索 ──
      const related = opts.resolveRelated?.(ctx.agentId) ?? [];
      let secondary: Array<Record<string, unknown>> = [];
      let usedTerms: string[] = [];
      if (related.length) {
        usedTerms = extractIndexTerms(
          (primary.hits as any[]).slice(0, 5).map((h) => String(h.excerpt ?? "")),
          String(input.query ?? ""),
        );
        // 主检索空命中（新工作区/全索引型 agent 常态）：用查询自身切词当二查钥匙，
        // 否则空区 agent 永远触发不了关联检索
        if (!usedTerms.length && !(primary.hits?.length ?? 0)) {
          const qt = String(input.query ?? "").match(/[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9+.#-]{2,}/g) ?? [];
          usedTerms = [...new Set(qt.map((t) => (/[\u4e00-\u9fff]/.test(t) ? t : t.toLowerCase())))].slice(0, 6);
        }
        if (usedTerms.length) {
          const q2 = usedTerms.join(" ");
          const caps: number[] = [];
          for (const rel of related) {
            try {
              if (rel.hybrid) {
                const rr = await rel.hybrid.search(q2, {
                  limit: 3,
                  source: "memory",
                  vectorWeight: opts.weights?.vectorWeight,
                  textWeight: opts.weights?.textWeight,
                });
                caps.push(rr.hits.length);
                secondary.push(...rr.hits.map((h) => ({ ...h, from: rel.name })));
              } else {
                const rr = await rel.searcher.search(q2, { maxResults: 3, corpus: "memory" });
                caps.push(rr.hits.length);
                secondary.push(...(rr.hits ?? []).map((h) => ({ ...h, from: rel.name })));
              }
            } catch {
              caps.push(0);
            }
          }
        }
      }
      opts.onStatus?.({ mode: String(primary.mode), hits: (primary.hits?.length ?? 0) + secondary.length });
      return {
        mode: primary.mode,
        // 主命中补 from=self 标记：与二查的 from:<agent> 同一坐标系，模型/用户才能分辨归属
        hits: [
          ...(primary.hits ?? []).map((h: any) => ({ from: "self", ...h })),
          ...secondary,
        ],
        ...(usedTerms.length
          ? { related: { terms: usedTerms, agents: related.map((x) => x.name), hits: secondary.length } }
          : {}),
      };
    },
  };
}
