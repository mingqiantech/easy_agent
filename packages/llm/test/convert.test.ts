import { describe, it, expect } from "bun:test";
import { toCoreMessages } from "../src/convert.js";
import type { Message } from "@easy-agent/schema/llm";

describe("toCoreMessages（工具循环消息契约）", () => {
  it("assistant 带 toolCalls 的 JSON → tool-call parts（保留 toolName）", () => {
    const out = toCoreMessages([
      {
        role: "assistant",
        content: JSON.stringify({
          text: "",
          toolCalls: [{ id: "t1", name: "bash", input: { command: "ls" } }],
        }),
      } as Message,
    ]);
    expect(out[0].role).toBe("assistant");
    expect(out[0].content[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "bash",
    });
  });

  it("tool 结果必须带 toolName（Anthropic tool-result 校验依赖它）", () => {
    const good = toCoreMessages([
      {
        role: "tool",
        content: JSON.stringify({
          toolCallId: "t1",
          toolName: "bash",
          result: { stdout: "ok" },
        }),
      } as Message,
    ]);
    expect(good[0].content[0].toolName).toBe("bash");

    // 回归：缺 toolName 时 ai-sdk 会拒绝整条 messages（子代理工具循环 400 的根因）
    const bad = toCoreMessages([
      {
        role: "tool",
        content: JSON.stringify({ toolCallId: "t1", result: { stdout: "ok" } }),
      } as Message,
    ]);
    expect(bad[0].content[0].toolName).toBeUndefined();
  });

  it("system/user 原样透传", () => {
    const out = toCoreMessages([
      { role: "system", content: "S" } as Message,
      { role: "user", content: "U" } as Message,
    ]);
    expect(out).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
  });
});
