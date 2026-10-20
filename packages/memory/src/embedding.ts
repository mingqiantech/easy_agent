import { tokenizeQuery } from "./search.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "text-embedding-3-small";
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const batches: Float32Array[][] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!response.ok) {
        throw new Error(
          `Embedding API error: ${response.status} ${await response.text()}`,
        );
      }

      const data = (await response.json()) as any;
      batches.push(data.data.map((d: any) => new Float32Array(d.embedding)));
    }
    return batches.flat();
  }
}

/**
 * Ollama 本地 Embedding（/api/embed 批量；旧版回退 /api/embeddings）
 * 例：{ provider:"ollama", baseUrl:"http://172.18.32.1:11434", model:"nomic-embed-text" }
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private baseUrl: string;
  private model: string;

  constructor(config: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = (config.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = config.model ?? "nomic-embed-text";
  }

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0]!;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      return (data.embeddings as number[][]).map((v) => new Float32Array(v));
    }
    // 旧版 ollama：/api/embeddings 单条 prompt
    const out: Float32Array[] = [];
    for (const t of texts) {
      const r = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: t }),
      });
      if (!r.ok) throw new Error(`Ollama embedding error: ${r.status} ${await r.text()}`);
      const d = (await r.json()) as any;
      out.push(new Float32Array(d.embedding));
    }
    return out;
  }
}

/**
 * 简易本地 Embedding（回退方案，零依赖零网络）
 * token 哈希词频向量；CJK 走 bigram 切词，中文短句相似度可用
 */
export class SimpleEmbeddingProvider implements EmbeddingProvider {
  private dim = 256;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    for (const word of tokenizeQuery(text)) {
      const idx = this.hash(word) % this.dim;
      vec[idx] += 1;
    }

    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    return vec;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  private hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
}
