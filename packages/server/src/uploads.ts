import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

/**
 * 图片上传落盘（Web UI / API 共用）：
 * - base64 → ~/.easy-agent/uploads/<id>.<ext>，DB 只存文件引用（metadata.images）
 * - 与 llm/convert.ts 的 UPLOADS_DIR 解析保持一致
 */
export const UPLOADS_DIR =
  process.env.EASY_AGENT_UPLOADS_DIR ??
  path.join(os.homedir(), ".easy-agent", "uploads");

const ALLOWED_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};
/** 单图 base64 解码后上限 5MB；单消息最多 4 张 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

export interface ImageRef {
  file: string;
  mimeType: string;
  name?: string;
  /** OCR 结果（非视觉模型预处理）；convert 层看到此字段即不再展开 image part */
  ocr?: string;
}

/**
 * 入参：前端 JSON body.images = [{name?, mimeType?, dataBase64}]
 * 返回 refs（写 metadata.images 用）；非法输入进 errors（调用方决定 400 还是忽略）
 */
export function saveImageUploads(
  images: unknown,
): { refs: ImageRef[]; errors: string[] } {
  const refs: ImageRef[] = [];
  const errors: string[] = [];
  if (!Array.isArray(images) || images.length === 0)
    return { refs, errors };
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    errors.push(`单条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
    return { refs, errors };
  }
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  for (const [i, img] of images.entries()) {
    const raw = String((img as any)?.dataBase64 ?? "");
    const declaredMime = String((img as any)?.mimeType ?? "");
    if (!raw) {
      errors.push(`第 ${i + 1} 张缺少 dataBase64`);
      continue;
    }
    // 兼容 dataURL 前缀
    const b64 = raw.replace(/^data:[^;]+;base64,/, "");
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      errors.push(`第 ${i + 1} 张 base64 解码失败`);
      continue;
    }
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      errors.push(
        `第 ${i + 1} 张大小非法（${buf.length} 字节，上限 ${MAX_IMAGE_BYTES >> 20}MB）`,
      );
      continue;
    }
    // 魔数嗅探为准（防伪造 mimeType），扩展名/ MIME 二选一能对上即可
    const sniffed = sniffImageMagic(buf);
    if (!sniffed) {
      errors.push(`第 ${i + 1} 张不是支持的图片格式（png/jpg/gif/webp/bmp）`);
      continue;
    }
    const id = crypto.randomUUID();
    const file = `${id}.${sniffed.ext}`;
    cleanupOldUploads();
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
    refs.push({
      file,
      mimeType: sniffed.mime,
      name:
        String((img as any)?.name ?? "").slice(0, 80) ||
        `image-${i + 1}.${sniffed.ext}`,
    });
    void declaredMime;
  }
  return { refs, errors };
}

function sniffImageMagic(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47)
    return { ext: "png", mime: "image/png" };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length > 6 && buf.toString("ascii", 0, 6).startsWith("GIF8"))
    return { ext: "gif", mime: "image/gif" };
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return { ext: "webp", mime: "image/webp" };
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d)
    return { ext: "bmp", mime: "image/bmp" };
  return null;
}

/**
 * 长文本卸载（OpenClaw 式）：超过阈值的用户消息落盘，上下文只留引用+预览，
 * 模型需要细节时用 read 工具按行取——避免大块日志/文档逐轮全价重复计费。
 * 阈值可 EASY_AGENT_LONG_TEXT_MIN_CHARS 调（<=0 禁用）。
 */
export const LONG_TEXT_MIN_CHARS = Number(
  process.env.EASY_AGENT_LONG_TEXT_MIN_CHARS ?? 4000,
);
const LONG_TEXT_PREVIEW_CHARS = 400;

export function offloadLongText(text: string): string {
  if (LONG_TEXT_MIN_CHARS <= 0 || text.length <= LONG_TEXT_MIN_CHARS)
    return text;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  cleanupOldUploads();
  const id = crypto.randomUUID();
  const abs = path.join(UPLOADS_DIR, `longtext-${id}.txt`);
  fs.writeFileSync(abs, text, "utf-8");
  return [
    `[长文本已存文件：${abs}（共 ${text.length} 字符）。需要细节用 read 工具按 offset/limit 分段读取，不要整份复述。]`,
    `--- 前 ${LONG_TEXT_PREVIEW_CHARS} 字预览 ---`,
    text.slice(0, LONG_TEXT_PREVIEW_CHARS),
    `…（其余 ${text.length - LONG_TEXT_PREVIEW_CHARS} 字在文件中）`,
  ].join("\n");
}

/** 懒清理：uploads 目录只增不减，写入新文件时顺手扫掉 30 天前的旧附件 */
function cleanupOldUploads(): void {
  try {
    const cutoff = Date.now() - 30 * 86400_000;
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch {}
    }
  } catch {}
}

/** 安全解析 uploads 文件名（防目录穿越）；非法返回 null */
export function resolveUploadFile(name: string): string | null {
  const base = path.basename(name);
  const ext = base.split(".").pop() ?? "";
  if (!ALLOWED_EXT[ext]) return null;
  const abs = path.join(UPLOADS_DIR, base);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 非视觉模型的图片预处理：调 rapidocr CLI（工作区守则统一入口）转文字。
 * best-effort：工具不存在/失败返回 null，调用方回退到原图传递。
 */
export async function ocrImage(
  absPath: string,
  timeoutMs = 60_000,
): Promise<string | null> {
  const script =
    process.env.EASY_AGENT_OCR_SCRIPT ??
    path.join(os.homedir(), "OCR_protert", "ocr_tool.py");
  if (!fs.existsSync(script)) return null;
  try {
    const proc = Bun.spawn(["python3", script, absPath, "--line"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const killer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(killer);
    const text = out.trim();
    return text ? text.slice(0, 4000) : null;
  } catch {
    return null;
  }
}
