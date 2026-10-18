import { describe, it, expect } from "bun:test";
import { pruneToolResults } from "../src/context.js";
import type { Message } from "@easy-agent/schema/llm";

const msg = (role: Message["role"], content: string): Message => ({
  role,
  content,
} as Message);

describe("pruneToolResults（上下文工程）", () => {
  it("只保留最近 keepLast 条工具结果全文，旧的换成短 stub", () => {
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
    expect(out[2].content.startsWith("[旧工具结果已修剪 500 字]")).toBe(true);
    expect(out[3].content).toBe("B".repeat(500).slice(0, 0) + "C".repeat(500)); // 最后一条保留全文
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
});
