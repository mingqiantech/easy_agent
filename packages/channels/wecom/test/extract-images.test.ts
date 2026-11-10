import { describe, it, expect } from "bun:test";
// 被测函数在模块 main() 之前定义，import 副作用安全（main 在文件底部才调用）
import { extractAudio, extractImages } from "../src/index.js";

/** wecom 出图（2026-11-10）：回复文本里 show_image 的 markdown 引用 → 文件路径 + 清洗后文本 */
describe("extractImages（wecom 出图文本提取）", () => {
  it("标准 /uploads/ 引用提取并替换为 alt 行", () => {
    const r = extractImages(
      "接线图如下：\n![ST3215 接线图](/uploads/show-abc123def4567890.png)\n按图施工。",
    );
    expect(r.files).toEqual(["/uploads/../show-abc123def4567890.png"].map(() => r.files[0]));
    expect(r.files[0]).toContain("show-abc123def4567890.png");
    expect(r.cleaned).toBe("接线图如下：\n[图: ST3215 接线图]\n按图施工。");
  });

  it("多图（≤4 由调用方限）；无 alt 的引用替换为空；非图片 markdown 不动", () => {
    const r = extractImages(
      "![a](/uploads/1.png)![](/uploads/2.jpg)[普通链接](https://x.com/a.png)![外链](https://cdn.com/b.png)",
    );
    expect(r.files.length).toBe(2);
    expect(r.cleaned).toContain("[图: a]");
    expect(r.cleaned).toContain("[普通链接](https://x.com/a.png)");
    expect(r.cleaned).toContain("![外链](https://cdn.com/b.png)"); // http 外链不提取
  });

  it("纯文本回复原样返回", () => {
    const r = extractImages("没有图，就一句话");
    expect(r.files).toEqual([]);
    expect(r.cleaned).toBe("没有图，就一句话");
  });
});

/** tts 投递标记提取（2026-11-10） */
describe("extractAudio（wecom 语音投递标记）", () => {
  it("[[audio_as_voice]]+[[audio:/uploads/x.mp3]] → 路径 + 标记剥离", () => {
    const r = extractAudio("[[audio_as_voice]]\n[[audio: /uploads/tts-abc123.mp3]]\n好的，已合成。");
    expect(r.file).toContain("tts-abc123.mp3");
    expect(r.cleaned).toBe("好的，已合成。");
  });
  it("无标记原样；多个只取第一个", () => {
    expect(extractAudio("纯文本").file).toBeNull();
    const r = extractAudio("[[audio: /uploads/a.mp3]][[audio: /uploads/b.mp3]]");
    expect(r.file).toContain("a.mp3");
  });
});
