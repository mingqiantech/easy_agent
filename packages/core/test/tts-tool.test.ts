import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** tts 自制工具测试（2026-11-10）：mock /audio/speech 服务，验证合成→落 uploads→投递标记 */
const TMP_UP = fs.mkdtempSync(path.join(os.tmpdir(), "ea-tts-up-"));
process.env.EASY_AGENT_UPLOADS_DIR = TMP_UP;

const { createTtsTool } = await import("../src/tool/builtins/tts.js");
const { TextToSpeech } = await import("../src/tts/index.js");

// mock TTS 服务：返回固定字节（假 mp3）
let lastBody: any = null;
const srv = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.url.endsWith("/audio/speech")) {
      lastBody = await req.json();
      return new Response(
        Buffer.from(`FAKE-MP3:${lastBody.input.length}`),
        { headers: { "Content-Type": "audio/mpeg" } },
      );
    }
    return new Response("nope", { status: 404 });
  },
});
const BASE = `http://localhost:${srv.port}`;

describe("tts 工具", () => {
  beforeAll(() => {
    // 空跑一次确保 mock 可达
  });

  it("合成落 uploads（内容寻址），返回投递标记", async () => {
    const tts = new TextToSpeech({ apiKey: "k", baseUrl: BASE });
    const tool = createTtsTool(tts);
    const r: any = await tool.execute({ text: "你好世界" }, { workDir: TMP_UP } as any);
    expect(r.audio).toMatch(/^\/uploads\/tts-[0-9a-f]{16}\.mp3$/);
    expect(r.block).toContain("[[audio_as_voice]]");
    expect(r.block).toContain(r.audio);
    expect(fs.existsSync(path.join(TMP_UP, r.audio.replace("/uploads/", "")))).toBe(true);
    // 服务端收到正确参数
    expect(lastBody.input).toBe("你好世界");
    expect(lastBody.response_format).toBe("mp3");
  });

  it("voice/speed 逐调用覆盖生效", async () => {
    const tts = new TextToSpeech({ apiKey: "k", baseUrl: BASE, voice: "alloy", speed: 1 });
    const tool = createTtsTool(tts);
    await tool.execute({ text: "abc", voice: "china", speed: 1.5 }, { workDir: TMP_UP } as any);
    expect(lastBody.voice).toBe("china");
    expect(lastBody.speed).toBe(1.5);
  });

  it("未配置 key → 友好报错；超长文本被 schema 拦", async () => {
    const tool = createTtsTool(new TextToSpeech({ apiKey: "" }));
    const r: any = await tool.execute({ text: "x" }, { workDir: TMP_UP } as any);
    expect(r.error).toContain("TTS 未配置");
    expect(tool.inputSchema.safeParse({ text: "x".repeat(2001) }).success).toBe(false);
  });

  it("服务故障 → 报错不崩", async () => {
    const tool = createTtsTool(new TextToSpeech({ apiKey: "k", baseUrl: "http://localhost:1" }));
    const r: any = await tool.execute({ text: "x" }, { workDir: TMP_UP } as any);
    expect(r.error).toContain("TTS 合成失败");
  });
});
