import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import os from "node:os";
import type { Tool, ToolContext } from "../types.js";

/** uploads 目录：与 llm/convert.ts、server/uploads.ts 同规则，但运行时才读 env——
 * 那两处是模块级常量，全量测试时会被最先 import 的文件冻结，导致写到错误目录 */
function uploadsDir(): string {
  return (
    process.env.EASY_AGENT_UPLOADS_DIR ??
    path.join(os.homedir(), ".easy-agent", "uploads")
  );
};

/**
 * show_image 工具（2026-11-02 elf 点单"增加图片展示"）：
 * 把本地图片发布到 uploads 目录并返回 Markdown 图片语法；
 * agent 将 markdown 原样贴进最终回复，聊天窗口即可内嵌展示。
 * 补的缺口：agent 生成了图（接线图/图表）却只能给文件路径，用户看不到图。
 */

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const MAX_BYTES = 20 * 1024 * 1024; // 20MB/张（比上传的 5MB 宽：生成的图可能很大）
const MAX_PATHS = 4;

const ShowImageInput = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(MAX_PATHS)
    .describe(
      `本地图片文件路径（绝对或相对工作目录），最多 ${MAX_PATHS} 张。支持 ${Object.keys(EXT_MIME).join("/")}`,
    ),
  alt: z
    .string()
    .max(80)
    .optional()
    .describe("图片说明文字（可选，用于 alt/悬停提示）"),
});

export function createShowImageTool(): Tool {
  return {
    name: "show_image",
    description:
      "在聊天窗口展示本地图片。传入图片文件路径，返回 Markdown 图片语法——把返回的 markdown 原样贴进最终回复文本，用户即可在对话里直接看图（不要只给文件路径让用户自己打开）。",
    inputSchema: ShowImageInput,

    async execute(input, ctx: ToolContext) {
      const out: string[] = [];
      const errors: string[] = [];
      const UP = uploadsDir();
      fs.mkdirSync(UP, { recursive: true });
      for (const p of input.paths) {
        const abs = path.isAbsolute(p) ? p : path.resolve(ctx.workDir, p);
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          errors.push(`文件不存在: ${abs}`);
          continue;
        }
        if (!st.isFile()) {
          errors.push(`不是文件: ${abs}`);
          continue;
        }
        const ext = abs.split(".").pop()?.toLowerCase() ?? "";
        if (!EXT_MIME[ext]) {
          errors.push(
            `不支持的格式 .${ext}（可用：${Object.keys(EXT_MIME).join("/")}）`,
          );
          continue;
        }
        if (st.size > MAX_BYTES) {
          errors.push(
            `超过 ${MAX_BYTES / 1024 / 1024}MB 上限: ${path.basename(abs)} (${(st.size / 1024 / 1024).toFixed(1)}MB)`,
          );
          continue;
        }
        // 内容寻址命名：同一张图重复发布不复制多份，且浏览器可长缓存
        const buf = fs.readFileSync(abs);
        const hash = crypto
          .createHash("sha1")
          .update(buf)
          .digest("hex")
          .slice(0, 16);
        const file = `show-${hash}.${ext}`;
        const dest = path.join(UP, file);
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
        const alt = input.alt ? String(input.alt).slice(0, 80) : path.basename(abs);
        out.push(`![${alt}](/uploads/${file})`);
      }
      if (!out.length)
        return { error: errors.join("；") || "没有可展示的图片" };
      return {
        markdown: out.join("\n"),
        served: out.length,
        hint: "把 markdown 字段原样贴进最终回复文本，聊天窗口会内嵌渲染这些图。",
        ...(errors.length ? { warnings: errors } : {}),
      };
    },
  };
}
