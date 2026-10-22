import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Message } from "@easy-agent/schema/llm";

/** 图片附件存储目录（与 server 上传路由一致，可用 env 覆盖） */
export const UPLOADS_DIR =
  process.env.EASY_AGENT_UPLOADS_DIR ??
  path.join(os.homedir(), ".easy-agent", "uploads");

/** 发给 LLM 时只保留最近 N 张图：旧图 token 成本高且模型大概率已看过/已处理 */
const KEEP_IMAGES = 3;

/** 图片文件 → dataURL；读不到（文件被清理）降级为文本占位，不阻断请求 */
function toDataUrl(img: { file: string; mimeType?: string; name?: string }): string | null {
  try {
    const abs = path.isAbsolute(img.file) ? img.file : path.join(UPLOADS_DIR, path.basename(img.file));
    const buf = readFileSync(abs);
    const mime = img.mimeType || (abs.endsWith(".png") ? "image/png" : abs.endsWith(".gif") ? "image/gif" : abs.endsWith(".webp") ? "image/webp" : abs.endsWith(".svg") ? "image/svg+xml" : "image/jpeg");
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * core 消息转换：
 * - user 消息带 metadata.images（服务端 uploads 文件引用）→ 展开为 text+image 多 part；
 *   只保留最近 KEEP_IMAGES 张，更早的换成文本占位（省 token，与 pruneToolResults 同一哲学）
 * - ai-sdk v4 的 {type:"image", image: dataURL} 格式 anthropic/openai provider 都支持
 */
export function toCoreMessages(messages: Message[]): any[] {
  // 从尾部数带图消息，确定哪些保留
  let seen = 0;
  const keep = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const imgs = (messages[i] as any).metadata?.images;
    if (messages[i].role === "user" && Array.isArray(imgs) && imgs.length) {
      if (seen < KEEP_IMAGES) keep.add(messages[i].id ?? String(i));
      seen += imgs.length;
    }
  }
  const out: any[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === "user" || m.role === "system") {
      const imgs = (m as any).metadata?.images;
      if (m.role === "user" && Array.isArray(imgs) && imgs.length) {
        const parts: any[] = [];
        if (m.content) parts.push({ type: "text", text: m.content });
        const keepThis = keep.has(m.id ?? String(mi));
        for (const img of imgs) {
          // 已 OCR 转文字的图：文本已在 content 里，不再发 image part（非视觉模型会报错）
          if (img.ocr) continue;
          if (!keepThis) {
            parts.push({ type: "text", text: `[图片 ${img.name ?? img.file} 已省略（超出最近 ${KEEP_IMAGES} 张窗口）]` });
            continue;
          }
          const url = toDataUrl(img);
          if (url) parts.push({ type: "image", image: url, alt: img.name ?? "user-uploaded image" });
          else parts.push({ type: "text", text: `[图片 ${img.name ?? img.file} 文件已不存在]` });
        }
        out.push({ role: "user", content: parts });
        continue;
      }
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(m.content);
      } catch {}
      if (Array.isArray(parsed?.toolCalls) && parsed.toolCalls.length) {
        const parts: any[] = [];
        if (parsed.text) parts.push({ type: "text", text: parsed.text });
        for (const tc of parsed.toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.input ?? {},
          });
        }
        out.push({ role: "assistant", content: parts });
      } else {
        out.push({ role: "assistant", content: parsed?.text ?? m.content });
      }
      continue;
    }
    if (m.role === "tool") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(m.content);
      } catch {}
      if (parsed?.toolCallId) {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: parsed.toolCallId,
              toolName: parsed.toolName,
              result: parsed.error ? { error: parsed.error } : parsed.result,
              ...(parsed.error ? { isError: true } : {}),
            },
          ],
        });
      }
    }
  }
  return out;
}
