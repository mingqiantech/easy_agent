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

  it("schema 限 ≤4 张；空输入运行时兜底报错", async () => {
    expect(tool.inputSchema.safeParse({ paths: [] }).success).toBe(true); // 允许空（靠 dir）
    expect(
      tool.inputSchema.safeParse({ paths: ["a", "b", "c", "d", "e"] }).success,
    ).toBe(false);
    const empty: any = await tool.execute({ paths: [] } as any, ctx);
    expect(empty.error).toContain("至少提供一个");
  });
  it("dir 批量：收目录图片按名排序，超 4 张截断提示", async () => {
    const sub = path.join(workDir, "gallery");
    fs.mkdirSync(sub, { recursive: true });
    for (const n of ["b.png", "a.png", "c.png"]) fs.writeFileSync(path.join(sub, n), PNG_1PX);
    const r: any = await tool.execute({ dir: sub }, ctx);
    const urls = (r.markdown.match(/\/uploads\/show-[0-9a-f]{16}\.png/g) ?? []);
    expect(urls.length).toBe(3); // 同内容去重后仍 3 行引用（同 hash）
    expect(r.served).toBe(3);
    const many = path.join(workDir, "many");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(many, `img${i}.png`), Buffer.concat([PNG_1PX, Buffer.from(`x${i}`)]));
    const r2: any = await tool.execute({ dir: many }, ctx);
    expect(r2.served).toBe(4);
    expect(r2.markdown).toContain("仅前 4 张");
  });
});
