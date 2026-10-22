import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// 必须在 import uploads 之前设 env（UPLOADS_DIR 是模块级常量）
process.env.EASY_AGENT_UPLOADS_DIR = "/tmp/easy-agent-test-uploads";
const { offloadLongText, LONG_TEXT_MIN_CHARS } = await import("../src/uploads.js");

describe("offloadLongText 长文本卸载", () => {
  it("阈值以下原样返回", () => {
    const t = "x".repeat(LONG_TEXT_MIN_CHARS - 10);
    expect(offloadLongText(t)).toBe(t);
  });

  it("超阈值→落盘，返回引用+预览+省略标记", () => {
    const t = "长日志行\n".repeat(900); // 4500 字符 > 4000 阈值
    const out = offloadLongText(t);
    expect(out).not.toBe(t);
    expect(out).toStartWith("[长文本已存文件：");
    expect(out).toContain(`共 ${t.length} 字符`);
    expect(out).toContain("长日志行"); // 预览含开头
    expect(out).toContain("字在文件中）");
    expect(out.length).toBeLessThan(1500);
    // 文件真实落盘且内容完整
    const m = out.match(/文件：(\S+\.txt)/);
    expect(m).toBeTruthy();
    const saved = fs.readFileSync(m![1], "utf-8");
    expect(saved).toBe(t);
    fs.unlinkSync(m![1]);
  });
});
