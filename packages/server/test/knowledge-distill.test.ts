import { describe, it, expect } from "bun:test";

const { collectDistillInput } = await import("../src/knowledge.js");

describe("collectDistillInput（蒸馏输入清洗）", () => {
  it("剔工具轮/system/巡检流水/空轮；assistant JSON 取 text；剥图片音频标记", () => {
    const msgs = [
      { role: "system", content: "工作区快照" },
      { role: "user", content: "怎么配 CAN 波特率" },
      { role: "assistant", content: JSON.stringify({ text: "BRP 分频对齐 80% 采样点", toolCalls: [{ name: "bash" }] }) },
      { role: "tool", content: '{"result":"..."}' },
      { role: "assistant", content: "![接线图](/uploads/show-abc.png)\n[[audio_as_voice]]\n按图接即可" },
      { role: "user", content: "F4 系列呢" },
      { role: "assistant", content: "F405 同 IP，APB1 42MHz 下 SJW=1/TMS=8/BRS=15 也 1Mbps" },
      { role: "user", content: "收到，整理个要点" },
      { role: "assistant", content: "要点：位时序 8~16tq、采样点 75-87.5%、先示波验证再上总线" },
      { role: "user", content: "✅ 巡检正常（一句话概要）" },
      { role: "assistant", content: "   " },
    ] as any;
    const out = collectDistillInput(msgs)!;
    expect(out).toContain("👤 怎么配 CAN 波特率");
    expect(out).toContain("BRP 分频");
    expect(out).toContain("[接线图]"); // markdown 图降级为 alt 文本
    expect(out).not.toContain("audio_as_voice");
    expect(out).not.toContain("巡检正常");
    expect(out).not.toContain("result"); // 工具轮丢弃
  });

  it("有效内容 <6 条 → null（不值得蒸馏）", () => {
    expect(collectDistillInput([{ role: "user", content: "hi" }] as any)).toBeNull();
    expect(collectDistillInput([])).toBeNull();
  });

  it("输入预算封顶（超长截 24k 内）", () => {
    const long = Array.from({ length: 60 }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(1500) }) as any);
    const out = collectDistillInput(long)!;
    expect(out.length).toBeLessThanOrEqual(25000);
  });
});
