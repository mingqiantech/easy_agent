import { describe, it, expect } from "bun:test";
import { pruneToolResults } from "../src/context.js";
import type { Message } from "@easy-agent/schema/llm";

const msg = (role: Message["role"], content: string): Message => ({
  role,
  content,
} as Message);

describe("pruneToolResults（上下文工程）", () => {
  it("量化水位线：默认 batch=2 时只修剪 keepLast 的整数倍（keepLast=1、3 条→修 1 条）", () => {
    const messages: Message[] = [
      msg("user", "hi"),
      msg("tool", "A".repeat(500)),
      msg("tool", "B".repeat(500)),
      msg("tool", "C".repeat(500)),
      msg("assistant", "done"),
    ];
    const out = pruneToolResults(messages, { keepLast: 1 });
    expect(out[0].content).toBe("hi");
    expect(out[1].content.startsWith("[旧工具结果已修剪 500 字]")).toBe(true);
    // B 在首个跳变点（第 4 条工具结果）之前保持全文 → 前缀冻结
    expect(out[2].content).toBe("B".repeat(500));
    expect(out[3].content).toBe("C".repeat(500));
    expect(out[4].content).toBe("done");
  });

  it("工具结果少于 keepLast 时不动", () => {
    const messages = [msg("tool", "short"), msg("user", "x")];
    const out = pruneToolResults(messages, { keepLast: 6 });
    expect(out[0].content).toBe("short");
  });

  it("超长消息截断到 maxChars 并加省略标记", () => {
    const long = "x".repeat(200);
    const out = pruneToolResults([msg("user", long)], { maxChars: 100 });
    expect(out[0].content.length).toBeLessThanOrEqual(110);
    expect(out[0].content.endsWith("…[截断]")).toBe(true);
  });

  it("不改动原数组（发给模型的副本 vs 完整存储）", () => {
    const original = [msg("tool", "y".repeat(500)), msg("tool", "z".repeat(500))];
    const snapshot = JSON.stringify(original);
    pruneToolResults(original, { keepLast: 0 });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("量化水位线：未达跳变点前多出的旧结果也保留全文，前缀冻结", () => {
    // keepLast=2、周期 4：3 条工具结果未达第 6 条跳变点 → 全部不动（旧版会修剪掉第 1 条）
    const messages = [msg("tool", "1".repeat(200)), msg("tool", "2".repeat(200)), msg("tool", "3".repeat(200))];
    const out = pruneToolResults(messages, { keepLast: 2 });
    expect(out.map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it("量化水位线：跳变点一次性修到 keepLast，两跳变间纯追加零改写", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => msg("tool", String.fromCharCode(65 + i).repeat(200)));
    // keepLast=2、周期 4：4/5 条未达跳变点（第 6 条）→ 全保持全文
    for (const n of [4, 5]) {
      const out = pruneToolResults(mk(n), { keepLast: 2 });
      expect(out.every((m, i) => m.content.length === 200)).toBe(true);
    }
    // 第 6 条 → 跳变：一次修 2 条（A、B），C-F 全文
    const at6 = pruneToolResults(mk(6), { keepLast: 2 });
    expect(at6[0].content.startsWith("[旧工具结果已修剪")).toBe(true);
    expect(at6[1].content.startsWith("[旧工具结果已修剪")).toBe(true);
    expect(at6[2].content).toBe("C".repeat(200));
    expect(at6[5].content).toBe("F".repeat(200));
    // 7、8 条：水位不变 → 旧消息零改写，纯追加
    const at8 = pruneToolResults(mk(8), { keepLast: 2 });
    for (let i = 0; i < 6; i++) expect(at8[i].content).toBe(at6[i].content);
    expect(at8[6].content).toBe("G".repeat(200));
    // 第 10 条 → 下个跳变点：水位升到 4
    const at10 = pruneToolResults(mk(10), { keepLast: 2 });
    expect(at10[3].content.startsWith("[旧工具结果已修剪")).toBe(true);
    expect(at10[0].content).toBe(at6[0].content); // 更早的 stub 不回退
  });

  it("EASY_AGENT_PRUNE_BATCH=1 退回逐轮滑动行为", () => {
    process.env.EASY_AGENT_PRUNE_BATCH = "1";
    try {
      const messages = [msg("tool", "A".repeat(200)), msg("tool", "B".repeat(200)), msg("tool", "C".repeat(200))];
      const out = pruneToolResults(messages, { keepLast: 1 });
      expect(out[0].content.startsWith("[旧工具结果已修剪")).toBe(true);
      expect(out[1].content.startsWith("[旧工具结果已修剪")).toBe(true);
      expect(out[2].content).toBe("C".repeat(200));
    } finally {
      delete process.env.EASY_AGENT_PRUNE_BATCH;
    }
  });
});
