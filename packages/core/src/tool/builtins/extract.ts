import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";

const ExtractInput = z.object({
  path: z.string().describe("文件路径（支持 .md/.txt/.json/.html/.pdf/.docx/.xlsx）"),
  maxChars: z.number().optional().describe("最大返回字符数（默认 50000）"),
});

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 文档提取工具（Week 10）
 * 纯文本类零依赖；pdf/docx/xlsx 需额外包，缺失时返回安装提示而非崩溃。
 */
export const extractTool: Tool = {
  name: "extract",
  description:
    "从文件提取文本内容。支持 md/txt/json/html/csv（无依赖）与 pdf/docx/xlsx（需可选依赖包）。",
  inputSchema: ExtractInput,

  async execute(input: any, ctx: ToolContext) {
    const filePath = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(ctx.workDir, input.path);
    const maxChars = input.maxChars ?? 50000;
    const ext = path.extname(filePath).toLowerCase();

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (e: any) {
      if (e.code === "ENOENT") return { error: `File not found: ${input.path}` };
      return { error: `Read failed: ${e.message}` };
    }

    const truncate = (text: string) => {
      const tooLong = text.length > maxChars;
      return {
        text: tooLong ? text.slice(0, maxChars) + "\n...[truncated]" : text,
        chars: text.length,
        truncated: tooLong,
      };
    };

    try {
      switch (ext) {
        case ".md":
        case ".txt":
        case ".log": {
          return truncate(buffer.toString("utf-8"));
        }

        case ".json": {
          const data = JSON.parse(buffer.toString("utf-8"));
          return truncate(JSON.stringify(data, null, 2));
        }

        case ".html":
        case ".htm": {
          return truncate(stripHtml(buffer.toString("utf-8")));
        }

        case ".csv": {
          return truncate(buffer.toString("utf-8"));
        }

        case ".pdf": {
          try {
            const mod: any = await import("pdf-parse" as string).catch(() => {
              throw new Error("missing");
            });
            const pdfParse = mod.default ?? mod;
            const data = await pdfParse(buffer);
            return { ...truncate(data.text), pages: data.numpages };
          } catch {
            return {
              error: "PDF extraction needs optional dependency: bun add pdf-parse",
            };
          }
        }

        case ".docx": {
          try {
            const mammoth: any = await import("mammoth" as string).catch(() => {
              throw new Error("missing");
            });
            const result = await mammoth.extractRawText({ buffer });
            return truncate(result.value);
          } catch {
            return {
              error: "DOCX extraction needs optional dependency: bun add mammoth",
            };
          }
        }

        case ".xlsx":
        case ".xls": {
          try {
            const XLSX: any = await import("xlsx" as string).catch(() => {
              throw new Error("missing");
            });
            const workbook = XLSX.read(buffer);
            const sheets: Record<string, string> = {};
            for (const name of workbook.SheetNames) {
              sheets[name] = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
            }
            return {
              ...truncate(JSON.stringify(sheets, null, 2)),
              sheetCount: workbook.SheetNames.length,
            };
          } catch {
            return {
              error: "Excel extraction needs optional dependency: bun add xlsx",
            };
          }
        }

        default: {
          // 未知扩展名：尝试按文本处理
          const text = buffer.toString("utf-8");
          if (text.includes("\u0000")) {
            return {
              error: `Binary file, cannot extract text: ${input.path} (${ext || "no extension"})`,
            };
          }
          return { ...truncate(text), note: `Unknown extension ${ext}, treated as text` };
        }
      }
    } catch (e: any) {
      return { error: `Extract failed (${ext}): ${e.message}` };
    }
  },
};
