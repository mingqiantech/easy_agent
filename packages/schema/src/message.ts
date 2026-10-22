import { z } from "zod";

export const MessageRole = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "function",
]);
export type MessageRole = z.infer<typeof MessageRole>;

/**
 * 图片附件（存服务端 uploads 目录，DB 只存引用，避免 base64 擑爆消息表）
 */
export const ImageAttachment = z.object({
  /** uploads 目录下的文件名（服务端负责拼绝对路径） */
  file: z.string(),
  mimeType: z.string(),
  name: z.string().optional(),
  /** 非视觉模型的 OCR 预识别文本（已拼入 content，发送时跳过 image part） */
  ocr: z.string().optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

export const Message = z.object({
  role: MessageRole,
  content: z.string(),
  id: z.string().optional(),
  createdAt: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});
export type Message = z.infer<typeof Message>;

export function userMessage(content: string): Message {
  return { role: "user", content };
}

export function assistantMessage(content: string): Message {
  return { role: "assistant", content };
}

export function systemMessage(content: string): Message {
  return { role: "system", content };
}
export function toolMessage(content: string): Message {
  return { role: "tool", content };
}
export function functionMessage(content: string): Message {
  return { role: "function", content };
}
