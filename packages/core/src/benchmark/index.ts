export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  p50TimeMs: number;
  p95TimeMs: number;
  opsPerSecond: number;
}

/**
 * 性能基准（Week 8 Step 5）
 * 预热 + 多次采样 + 分位数统计。
 */
export class Benchmark {
  static async run(
    name: string,
    fn: () => Promise<void>,
    options: { iterations?: number; warmup?: number } = {},
  ): Promise<BenchmarkResult> {
    const iterations = options.iterations ?? 100;
    const warmup = options.warmup ?? 5;

    for (let i = 0; i < warmup; i++) await fn();

    const times: number[] = [];
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const s = performance.now();
      await fn();
      times.push(performance.now() - s);
    }
    const totalTimeMs = performance.now() - start;

    times.sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const percentile = (q: number) =>
      times[Math.min(times.length - 1, Math.floor(times.length * q))];

    return {
      name,
      iterations,
      totalTimeMs,
      avgTimeMs: sum / iterations,
      minTimeMs: times[0] ?? 0,
      maxTimeMs: times[times.length - 1] ?? 0,
      p50TimeMs: percentile(0.5),
      p95TimeMs: percentile(0.95),
      opsPerSecond: iterations / (totalTimeMs / 1000),
    };
  }

  static format(r: BenchmarkResult): string {
    return [
      `📊 ${r.name} (${r.iterations} iters)`,
      `   avg ${r.avgTimeMs.toFixed(2)}ms | p50 ${r.p50TimeMs.toFixed(2)}ms | p95 ${r.p95TimeMs.toFixed(2)}ms`,
      `   min ${r.minTimeMs.toFixed(2)}ms | max ${r.maxTimeMs.toFixed(2)}ms`,
      `   ${r.opsPerSecond.toFixed(1)} ops/s`,
    ].join("\n");
  }
}
