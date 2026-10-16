import { createHash } from "node:crypto";
import type { LLMResponse } from "@easy-agent/schema/llm";

const DEFAULT_TTL_MS = 7 * 86400000;

/**
 * LLM 响应缓存（Week 8 Step 5）
 * 相同请求（model+system+messages）直接复用，节省 API 成本。
 * 默认 TTL 7 天，带命中统计。
 */
export class LLMCache {
  private store = new Map<string, { response: LLMResponse; storedAt: number }>();
  hits = 0;
  misses = 0;

  constructor(private ttlMs: number = DEFAULT_TTL_MS) {}

  get size(): number {
    return this.store.size;
  }

  private key(model: string, system: string | undefined, messages: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify({ model, system, messages }))
      .digest("hex");
  }

  get(model: string, system: string | undefined, messages: unknown): LLMResponse | null {
    const k = this.key(model, system, messages);
    const entry = this.store.get(k);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.store.delete(k);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.response;
  }

  set(model: string, system: string | undefined, messages: unknown, response: LLMResponse): void {
    this.store.set(this.key(model, system, messages), { response, storedAt: Date.now() });
  }

  /** 清理过期条目，返回删除数量 */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.store) {
      if (now - v.storedAt > this.ttlMs) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/**
 * 并发请求池（Week 8 Step 5）
 * 限制同时进行的 LLM 请求数，防止 API 限流。
 */
export class RequestPool {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private maxConcurrent: number = 3) {}

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.queue.length;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}
