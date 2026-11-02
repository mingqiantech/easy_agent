import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** show_image 工具测试（2026-11-02 增加图片展示）：发布到 uploads、内容寻址幂等、格式/大小闸门 */
const TMP_UP = fs.mkdtempSync(path.join(os.tmpdir(), "ea-uploads-"));
process.env.EASY_AGENT_UPLOADS_DIR = TMP_UP;

const { createShowImageTool } = await import("../src/tool/builtins/show-image.js");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("show_image", () => {
  const tool = createShowImageTool();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-work-"));
  const ctx: any = { workDir, agentId: "test" };

  beforeAll(() => {
    fs.writeFileSync(path.join(workDir, "a.png"), PNG_1PX);
    fs.writeFileSync(path.join(workDir, "b.txt"), "not an image");
  });

  it("发布本地图片 → 返回 /uploads/ markdown；重复发布内容寻址去重", async () => {
    const r: any = await tool.execute({ paths: [path.join(workDir, "a.png")] }, ctx);
    expect(r.markdown).toMatch(/^!\[a\.png\]\(\/uploads\/show-[0-9a-f]{16}\.png\)$/);
    const r2: any = await tool.execute({ paths: ["a.png"], alt: "说明图" }, ctx); // 相对路径也收
    expect(r2.markdown).toBe(`![说明图](${r.markdown.slice(r.markdown.indexOf("](/") + 2, -1)})`);
    expect(fs.readdirSync(TMP_UP).filter((f) => f.endsWith(".png")).length).toBe(1);
  });

  it("非图片/不存在 → 报错；混入部分成功走 warnings", async () => {
    const bad: any = await tool.execute({ paths: ["b.txt"] }, ctx);
    expect(bad.error).toContain("不支持的格式");
    const miss: any = await tool.execute({ paths: [path.join(workDir, "nope.png")] }, ctx);
    expect(miss.error).toContain("文件不存在");
    const mixed: any = await tool.execute({ paths: ["a.png", "nope.png"] }, ctx);
    expect(mixed.markdown).toContain("/uploads/show-");
    expect(mixed.warnings.length).toBe(1);
  });

  it("schema 限 1-4 张", () => {
    expect(tool.inputSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ paths: ["a", "b", "c", "d", "e"] }).success,
    ).toBe(false);
  });
});
