import { describe, it, expect } from "bun:test";
import { Benchmark } from "../src/benchmark/index.js";
import { LLMCache } from "../src/llm-cache.js";
import { RequestPool } from "../src/llm-cache.js";

describe("Benchmark", () => {
  it("measures an async function and reports percentiles", async () => {
    const result = await Benchmark.run(
      "sleep-1ms",
      async () => new Promise((r) => setTimeout(r, 1)),
      { iterations: 10, warmup: 2 },
    );

    expect(result.name).toBe("sleep-1ms");
    expect(result.iterations).toBe(10);
    expect(result.avgTimeMs).toBeGreaterThanOrEqual(0.5);
    expect(result.p50TimeMs).toBeLessThanOrEqual(result.p95TimeMs);
    expect(result.opsPerSecond).toBeGreaterThan(0);
    expect(Benchmark.format(result)).toContain("sleep-1ms");
  });
});

describe("LLMCache", () => {
  const fakeResponse = {
    content: "hello",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };

  it("caches identical requests", () => {
    const cache = new LLMCache();
    const messages = [{ role: "user" as const, content: "hi" }];

    expect(cache.get("m", "s", messages)).toBeNull();
    cache.set("m", "s", messages, fakeResponse as any);
    const hit = cache.get("m", "s", messages);
    expect(hit?.content).toBe("hello");
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("different requests do not collide", () => {
    const cache = new LLMCache();
    cache.set("m", "s", [{ role: "user", content: "a" }], fakeResponse as any);
    expect(cache.get("m", "s", [{ role: "user", content: "b" }])).toBeNull();
  });

  it("expires entries after TTL", async () => {
    const cache = new LLMCache(10); // 10ms TTL
    const messages = [{ role: "user", content: "x" }];
    cache.set("m", undefined, messages, fakeResponse as any);
    expect(cache.get("m", undefined, messages)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 30));
    expect(cache.get("m", undefined, messages)).toBeNull();
  });

  it("cleanup removes expired entries", async () => {
    const cache = new LLMCache(10);
    cache.set("m", "s", [1], fakeResponse as any);
    cache.set("m2", "s", [2], fakeResponse as any);
    await new Promise((r) => setTimeout(r, 30));
    expect(cache.cleanup()).toBe(2);
    expect(cache.size).toBe(0);
  });
});

describe("RequestPool", () => {
  it("limits concurrency to maxConcurrent", async () => {
    const pool = new RequestPool(2);
    let active = 0;
    let peak = 0;

    const task = () =>
      pool.execute(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return "done";
      });

    const results = await Promise.all([task(), task(), task(), task(), task()]);

    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual(["done", "done", "done", "done", "done"]);
    expect(pool.active).toBe(0);
  });

  it("propagates errors without blocking the queue", async () => {
    const pool = new RequestPool(1);
    await expect(
      pool.execute(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // 队列没有被卡死
    const ok = await pool.execute(async () => 42);
    expect(ok).toBe(42);
  });
});
