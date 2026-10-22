import { describe, it, expect } from "bun:test";
import { toCoreMessages } from "../src/convert.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = path.join(os.homedir(), ".easy-agent", "uploads");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("toCoreMessages 图片附件", () => {
  it("user 消息 metadata.images → text+image 多 part", () => {
    fs.mkdirSync(DIR, { recursive: true });
    const f = "test-img-convert.png";
    fs.writeFileSync(path.join(DIR, f), PNG);
    try {
      const out = toCoreMessages([
        { role: "user", content: "看下这张图", metadata: { images: [{ file: f, mimeType: "image/png", name: "t.png" }] } } as any,
      ]);
      expect(out[0].role).toBe("user");
      expect(Array.isArray(out[0].content)).toBe(true);
      expect(out[0].content[0]).toEqual({ type: "text", text: "看下这张图" });
      expect(out[0].content[1].type).toBe("image");
      expect(out[0].content[1].image).toStartWith("data:image/png;base64,");
    } finally {
      fs.unlinkSync(path.join(DIR, f));
    }
  });

  it("带 ocr 标记的图不展开 image part（文本已在 content）", () => {
    const out = toCoreMessages([
      { role: "user", content: "OCR内容已拼入", metadata: { images: [{ file: "gone.png", mimeType: "image/png", ocr: "识别文本" }] } } as any,
    ]);
    const c = out[0].content;
    const parts = Array.isArray(c) ? c : [{ type: "text", text: c }];
    expect(parts.some((x: any) => x.type === "image")).toBe(false);
    expect(JSON.stringify(c)).not.toContain("gone.png");
  });

  it("图片文件缺失降级为文本占位，不抛异常", () => {
    const out = toCoreMessages([
      { role: "user", content: "hi", metadata: { images: [{ file: "no-such-file-xyz.png", mimeType: "image/png" }] } } as any,
    ]);
    expect(JSON.stringify(out[0].content)).toContain("文件已不存在");
  });

  it("超出最近 3 张窗口的旧图省略", () => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, "x.png"), PNG);
    const mk = (id: string) =>
      ({ role: "user", content: "m" + id, id, metadata: { images: [{ file: "x.png", mimeType: "image/png" }] } }) as any;
    const msgs = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
    const out = toCoreMessages(msgs);
    const kinds = out.map((m: any) => (Array.isArray(m.content) ? m.content.some((p: any) => p.type === "image") : false));
    // 从尾部数：e d c 保留（3 张窗口），b a 省略
    expect(kinds).toEqual([false, false, true, true, true]);
  });

  it("无图消息保持原字符串 content（回归）", () => {
    const out = toCoreMessages([{ role: "user", content: "纯文本" }]);
    expect(out[0]).toEqual({ role: "user", content: "纯文本" });
  });
});
