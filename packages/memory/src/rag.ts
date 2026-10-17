import fs from "node:fs/promises";
import path from "node:path";

export interface ChunkingOptions {
  /** 每块最大字符数（默认 500） */
  maxChunkSize?: number;
  /** 相邻块重叠字符数（默认 50） */
  overlap?: number;
  /** 优先按段落切分（默认 true） */
  splitByParagraph?: boolean;
}

export interface RagChunk {
  documentId: string;
  content: string;
  startChar: number;
  endChar: number;
  chunkIndex: number;
}

/**
 * 文本分块（纯函数，可单测）
 */
export function chunkText(
  text: string,
  documentId: string,
  options: ChunkingOptions = {},
): RagChunk[] {
  const maxChunkSize = options.maxChunkSize ?? 500;
  const overlap = Math.min(options.overlap ?? 50, maxChunkSize - 1);
  const splitByParagraph = options.splitByParagraph ?? true;

  const chunks: RagChunk[] = [];

  if (splitByParagraph) {
    const paragraphs = text.split(/\n{2,}/);
    let current = "";
    let start = 0;
    let cursor = 0;

    for (const para of paragraphs) {
      const paraIndex = text.indexOf(para, cursor);
      if (current && current.length + para.length + 2 > maxChunkSize) {
        const trimmedEnd = start + current.length;
        chunks.push({ documentId, content: current.trim(), startChar: start, endChar: trimmedEnd, chunkIndex: chunks.length });
        // 重叠：保留尾部
        const tail = current.slice(Math.max(0, current.length - overlap));
        start = paraIndex - tail.length;
        current = tail ? `${tail}\n\n${para}` : para;
      } else {
        if (!current) start = paraIndex;
        current += (current ? "\n\n" : "") + para;
      }
      cursor = paraIndex + para.length;
    }
    if (current.trim()) {
      chunks.push({ documentId, content: current.trim(), startChar: start, endChar: start + current.length, chunkIndex: chunks.length });
    }
    return chunks;
  }

  // 定长切分
  for (let i = 0; i < text.length; i += maxChunkSize - overlap) {
    const end = Math.min(i + maxChunkSize, text.length);
    chunks.push({ documentId, content: text.slice(i, end), startChar: i, endChar: end, chunkIndex: chunks.length });
    if (end >= text.length) break;
  }
  return chunks;
}

export interface LLMGenerateFn {
  (params: { system: string; prompt: string; maxTokens?: number }): Promise<string>;
}

export interface RagAnswer {
  answer: string;
  sources: Array<{ documentId: string; content: string; score: number }>;
  usedContext: boolean;
}

/**
 * 极简内存 RAG 索引 + 检索增强问答（Week 11）
 *
 * LLM 通过注入的 generate 函数调用，便于测试与替换模型。
 * 检索用词频重合打分（无 embedding 依赖）；生产可与 HybridSearch 组合。
 */
export class RagIndex {
  private chunks: RagChunk[] = [];

  get size(): number {
    return this.chunks.length;
  }

  /** 导入单个文本文件 */
  async addFile(filePath: string, options?: ChunkingOptions): Promise<number> {
    const text = await fs.readFile(filePath, "utf-8");
    const docId = path.basename(filePath);
    const chunks = chunkText(text, docId, options);
    this.chunks.push(...chunks);
    return chunks.length;
  }

  /** 导入目录下所有 .md/.txt */
  async addDirectory(dir: string, options?: ChunkingOptions): Promise<{ files: number; chunks: number }> {
    let files = 0;
    let chunkCount = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [] as any[]);
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      chunkCount += await this.addFile(path.join(dir, e.name), options);
      files++;
    }
    return { files, chunks: chunkCount };
  }

  /** 关键词提取：空白分词 + CJK 二元组（"怎么构建" → "怎么","么构","构建"...） */
  private keywordsOf(query: string): string[] {
    const raw = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    const out: string[] = [];
    for (const w of raw) {
      const isCJK = /[\u4e00-\u9fff]/.test(w);
      if (isCJK && w.length >= 2) {
        for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
      } else if (w.length > 1) {
        out.push(w);
      }
    }
    return out;
  }

  /** 检索 topK 相关块 */
  retrieve(query: string, topK = 5): Array<{ chunk: RagChunk; score: number }> {
    const keywords = this.keywordsOf(query);
    if (keywords.length === 0) return [];

    return this.chunks
      .map((chunk) => {
        const lower = chunk.content.toLowerCase();
        const matches = keywords.filter((kw) => lower.includes(kw)).length;
        return { chunk, score: matches / keywords.length };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** RAG 问答：检索 → 注入上下文 → LLM 生成 */
  async ask(query: string, llm: LLMGenerateFn, options: { topK?: number } = {}): Promise<RagAnswer> {
    const retrieved = this.retrieve(query, options.topK ?? 5);

    if (retrieved.length === 0) {
      return { answer: "知识库中未找到相关信息。", sources: [], usedContext: false };
    }

    const context = retrieved
      .map((r, i) => `[Source ${i + 1}: ${r.chunk.documentId}]\n${r.chunk.content}`)
      .join("\n\n---\n\n");

    const answer = await llm({
      system:
        "你是知识库问答助手。只基于提供的上下文回答问题；上下文没有相关信息时明确说明。在回答末尾列出引用的来源编号。",
      prompt: `上下文:\n\n${context}\n\n问题: ${query}`,
      maxTokens: 1500,
    });

    return {
      answer,
      sources: retrieved.map((r) => ({
        documentId: r.chunk.documentId,
        content: r.chunk.content,
        score: r.score,
      })),
      usedContext: true,
    };
  }

  clear(): void {
    this.chunks = [];
  }
}
