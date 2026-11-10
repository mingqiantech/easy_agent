import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { Tool, ToolContext } from "../types.js";
import type { TextToSpeech } from "../../tts/index.js";

/**
 * tts 工具（2026-11-10 elf 点单"自制工具+配置"）：
 * 文本 → OpenAI 兼容 /audio/speech → mp3 落 uploads 目录（可服务化），
 * 返回 [[audio_as_voice]] 提示 + /uploads/ 引用行——
 * wecom 桥接识别后转语音消息发送；Web UI 侧显示为可点开的音频链接。
 */

function uploadsDir(): string {
  return (
    process.env.EASY_AGENT_UPLOADS_DIR ??
    path.join(process.env.HOME ?? "/tmp", ".easy-agent", "uploads")
  );
}

const MAX_CHARS = 2000; // 多数 TTS 接口单请求上限 ~4k，取稳妥值

export function createTtsTool(tts: TextToSpeech): Tool {
  return {
    name: "tts",
    description:
      "把文本合成语音（mp3）。用于用户明确要求「语音/朗读/说一说」时；日常回答不要主动用。返回内容含 [[audio_as_voice]] 标记与音频引用行，把这两行原样放进最终回复即可投递语音（企微会自动转语音消息）。单次最长 2000 字。",
    inputSchema: z.object({
      text: z.string().min(1).max(MAX_CHARS).describe("要合成的文本（≤2000 字）"),
      voice: z.string().max(60).optional().describe("音色名，缺省用配置文件 tts.voice"),
      speed: z.number().min(0.5).max(2).optional().describe("语速 0.5–2.0，缺省 1.0"),
    }),

    async execute(input) {
      if (!tts.available)
        return { error: "TTS 未配置：easy-agent.json 的 tts.apiKey（ea-config tts key …）" };
      try {
        const r = await tts.synthesize(input.text, undefined, {
          voice: input.voice,
          speed: input.speed,
        });
        // 内容寻址进 uploads（同文本重复合成不占多份；wecom 桥接从该路径上传）
        const buf = fs.readFileSync(r.path);
        const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
        const file = `tts-${hash}.mp3`;
        const dest = path.join(uploadsDir(), file);
        fs.mkdirSync(uploadsDir(), { recursive: true });
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
        fs.rmSync(r.path, { force: true }); // 临时件用完即清
        return {
          audio: `/uploads/${file}`,
          bytes: buf.length,
          hint: "把下面两行原样放进最终回复文本：\n[[audio_as_voice]]\n[[audio: /uploads/" + file + "]]",
          block: `[[audio_as_voice]]\n[[audio: /uploads/${file}]]`,
        };
      } catch (e: any) {
        return { error: `TTS 合成失败: ${String(e?.message).slice(0, 200)}` };
      }
    },
  };
}
