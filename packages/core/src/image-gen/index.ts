export interface GeneratedImage {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
}

export interface ImageGenOptions {
  size?: "256x256" | "512x512" | "1024x1024";
  n?: number;
}

const VALID_SIZES = ["256x256", "512x512", "1024x1024"];

/**
 * 图片生成（Week 8）
 * 默认走 OpenAI 兼容 /images/generations 接口（Ark 等网关同样兼容）。
 */
export class ImageGenerator {
  private baseUrl: string;
  private model: string;

  constructor(opts: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.model = opts.model ?? "dall-e-3";
  }

  get available(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  validateSize(size: string): boolean {
    return VALID_SIZES.includes(size);
  }

  async generate(prompt: string, options: ImageGenOptions = {}): Promise<GeneratedImage[]> {
    if (!this.available) {
      throw new Error("Image generation not configured (set OPENAI_API_KEY)");
    }
    if (!prompt.trim()) throw new Error("Prompt is empty");

    const size = options.size ?? "1024x1024";
    if (!this.validateSize(size)) {
      throw new Error(`Invalid size: ${size}. Allowed: ${VALID_SIZES.join(", ")}`);
    }

    const res = await fetch(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt,
        size,
        n: options.n ?? 1,
      }),
    });

    if (!res.ok) {
      throw new Error(`Image API error: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    return (data.data ?? []).map((d: any) => ({
      url: d.url,
      b64Json: d.b64_json,
      revisedPrompt: d.revised_prompt,
    }));
  }
}
