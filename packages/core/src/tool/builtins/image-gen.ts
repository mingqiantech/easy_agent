import { z } from "zod";
import type { Tool } from "../types.js";
import { ImageGenerator } from "../../image-gen/index.js";

/**
 * image_gen 工具（Week 8）
 * 让 Agent 在对话中生成图片。
 */
export function createImageGenTool(gen: ImageGenerator): Tool {
  return {
    name: "image_gen",
    description:
      "AI 生成图片。输入文字描述，返回图片 URL。size 可选 256x256/512x512/1024x1024（默认 1024x1024）。" +
      "需要 OPENAI_API_KEY（或兼容网关）。",
    inputSchema: z.object({
      prompt: z.string().describe("图片描述（越具体越好）"),
      size: z.enum(["256x256", "512x512", "1024x1024"]).optional(),
      n: z.number().int().min(1).max(4).optional(),
    }),

    async execute(input: any) {
      if (!gen.available) {
        return { error: "Image generation not configured (set OPENAI_API_KEY)" };
      }
      try {
        const images = await gen.generate(input.prompt, {
          size: input.size,
          n: input.n,
        });
        return { images, count: images.length };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  };
}
