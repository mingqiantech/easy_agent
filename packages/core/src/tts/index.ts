import fs from "node:fs/promises";
import path from "node:path";

export interface TTSConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  speed?: number;
}

/**
 * 文字转语音（Week 8）
 * 默认走 OpenAI 兼容的 /audio/speech 接口（Ark 等网关同样兼容）。
 */
export class TextToSpeech {
  private config: TTSConfig;

  constructor(config: TTSConfig) {
    this.config = config;
  }

  get available(): boolean {
    return !!this.config.apiKey;
  }

  async synthesize(
    text: string,
    outputDir = path.join(process.env.HOME ?? "/tmp", ".local", "share", "easy-agent", "tts"),
  ): Promise<{ path: string; bytes: number; durationMs: number }> {
    if (!this.available) throw new Error("TTS not configured (no API key)");

    const start = Date.now();
    await fs.mkdir(outputDir, { recursive: true });

    const baseUrl = this.config.baseUrl ?? "https://api.openai.com/v1";
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model ?? "tts-1",
        voice: this.config.voice ?? "alloy",
        speed: this.config.speed ?? 1,
        input: text,
      }),
    });

    if (!res.ok) {
      throw new Error(`TTS API error: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const outPath = path.join(outputDir, `tts_${Date.now()}.mp3`);
    await fs.writeFile(outPath, buffer);

    return { path: outPath, bytes: buffer.length, durationMs: Date.now() - start };
  }
}
