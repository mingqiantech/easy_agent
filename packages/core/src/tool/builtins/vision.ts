import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";

const VisionInput = z.object({
  url: z.string().describe("图片 URL"),
  question: z.string().describe("关于图片的问题"),
});

export function createVisionTool(model: string): Tool {
  return {
    name: "vision",
    description: "分析图片内容。可以回答关于图片的问题。",
    inputSchema: VisionInput,

    async execute(input: any, ctx: ToolContext) {
      // 用支持 vision 的模型分析图片
      const response = await fetch(
        "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ***}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: input.question },
                  { type: "image_url", image_url: { url: input.url } },
                ],
              },
            ],
            max_tokens: 1000,
          }),
        },
      );

      if (!response.ok) return { error: `Vision API: ${response.status}` };
      const data = (await response.json()) as any;
      return { description: data.choices?.[0]?.message?.content ?? "" };
    },
  };
}
