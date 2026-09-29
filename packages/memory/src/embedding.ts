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
          Authorization: `Bearer ${this.baseUrl}`,
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!response.ok) {
        throw new ERROR(
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
 * 简易本地 Embedding（回退方案）
 * 使用简单的 TF-IDF 风格的词频向量
 */
export class SimpleEmbeddingProvider implements EmbeddingProvider {
  private vocab: Map<string, number> = new Map();
  private dim = 256;

  async embed(text: string): Promise<Float32Array> {
    const vec = new Float32Array(this.dim);
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
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
