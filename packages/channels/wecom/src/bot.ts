import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  WSClient,
  generateReqId,
  type WsFrame,
  type BaseMessage,
} from "@wecom/aibot-node-sdk";
import type {
  ChannelAdapter,
  ChannelMessage,
  SendMessageOptions,
} from "@easy-agent/core/channel/types";

export interface WeComConfig {
  /** 企业微信后台「智能机器人」的 botId */
  botId: string;
  /** 机器人 Secret */
  secret: string;
  /** 白名单 userid；空数组 = 放行全部 */
  allowedUserIds?: string[];
  /** 收到的图片/文件落盘目录（默认 ~/.easy-agent/uploads） */
  mediaDir?: string;
}

const UPLOAD_DIR = path.join(os.homedir(), ".easy-agent", "uploads");

/**
 * 企微帧 body → easy_agent ChannelMessage（纯函数，便于单测）。
 * 智能机器人群聊消息只在被 @ 时投递，故 group 到达即视为 mentioned。
 */
export function frameToChannelMessage(
  body: BaseMessage,
  opts: { mediaPaths?: string[] } = {},
): ChannelMessage {
  const isGroup = body.chattype === "group";
  const chatId = isGroup ? body.chatid ?? body.from.userid : body.from.userid;
  let text = "";
  switch (body.msgtype) {
    case "text":
      text = (body as any).text?.content ?? "";
      break;
    case "voice":
      // SDK 已内置语音转文本
      text = (body as any).voice?.content ?? "";
      break;
    case "image":
      text = "[用户发来图片]";
      break;
    case "file":
      text = "[用户发来文件]";
      break;
    case "mixed": {
      const items: any[] = (body as any).mixed?.items ?? [];
      text = items
        .map((it) => (it.msgtype === "text" ? it.text?.content ?? "" : `[${it.msgtype}]`))
        .join(" ");
      break;
    }
    default:
      text = `[不支持的消息类型: ${body.msgtype}]`;
  }
  const mediaNote = (opts.mediaPaths ?? [])
    .map((p) => `已保存到 ${p}（图片可走 OCR 工具识别，文件可用 read 查看）`)
    .join("\n");
  if (mediaNote) text += `\n${mediaNote}`;
  // 引用消息上下文拼进文本，模型可见
  const q = body.quote;
  if (q?.text?.content) text = `（引用: ${q.text.content.slice(0, 200)}）\n${text}`;
  return {
    channel: "wecom",
    senderId: body.from.userid,
    senderName: body.from.userid,
    text,
    messageId: body.msgid,
    chatId,
    isGroup,
    // 智能机器人群聊只投递 @ 它的事件，到达即视为被提及
    mentioned: true,
    timestamp: (body.create_time ?? Date.now() / 1000) * 1000,
    attachments: (opts.mediaPaths ?? []).map((p) => ({
      type: "image" as const,
      url: `file://${p}`,
      mimeType: "application/octet-stream",
    })),
  };
}

export class WeComAdapter implements ChannelAdapter {
  readonly name = "wecom";
  private config: WeComConfig;
  private handlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private client: WSClient | null = null;
  /** chatId → 最近一帧，回复走该帧的流式回复通道（机器人会话内回复） */
  private lastFrame = new Map<string, WsFrame<BaseMessage>>();
  private seenMsgIds = new Set<string>();

  constructor(config: WeComConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.botId || !this.config.secret)
      throw new Error("wecom: botId/secret 未配置");
    const client = new WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
      maxReconnectAttempts: -1, // 断线无限重连（长连接是出向的，NAT 无障碍）
    });
    this.client = client;

    client.on("authenticated", () =>
      console.log("🔐 WeCom 智能机器人认证成功，长连接就绪"),
    );
    client.on("disconnected", () => console.warn("🔌 WeCom 连接断开，重连中…"));

    const types = ["text", "image", "mixed", "voice", "file"] as const;
    for (const t of types) {
      (client.on as any)(`message.${t}`, (frame: WsFrame<BaseMessage>) =>
        this.handleFrame(frame),
      );
    }

    await client.connect();
    console.log("📡 WeCom channel listening");
  }

  async stop(): Promise<void> {
    this.client?.disconnect();
    this.client = null;
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handlers.push(handler);
  }

  private async handleFrame(frame: WsFrame<BaseMessage>): Promise<void> {
    const body = frame.body;
    if (!body?.from?.userid || !body.msgid) return;
    // 排重
    if (this.seenMsgIds.has(body.msgid)) return;
    this.seenMsgIds.add(body.msgid);
    if (this.seenMsgIds.size > 2000) {
      // 粗删：保留最近一半
      for (const id of Array.from(this.seenMsgIds).slice(0, 1000))
        this.seenMsgIds.delete(id);
    }
    // 白名单
    const allow = this.config.allowedUserIds ?? [];
    if (allow.length && !allow.includes(body.from.userid)) return;

    this.lastFrame.set(this.chatIdOf(body), frame);

    // 媒体下载解密落盘（url 五分钟有效，立刻拿）
    const mediaPaths: string[] = [];
    const dir = this.config.mediaDir ?? UPLOAD_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const dl = async (url: string, aeskey?: string, hint?: string) => {
      try {
        const { buffer, filename } = await this.client!.downloadFile(url, aeskey);
        const name = `wecom-${Date.now()}-${hint ?? filename ?? "media"}`;
        const p = path.join(dir, name.replace(/[^\w.\u4e00-\u9fff-]/g, "_"));
        fs.writeFileSync(p, buffer);
        mediaPaths.push(p);
      } catch (e: any) {
        console.warn("WeCom 媒体下载失败:", String(e?.message).slice(0, 120));
      }
    };
    if (body.msgtype === "image")
      await dl((body as any).image?.url, (body as any).image?.aeskey, "image.jpg");
    if (body.msgtype === "file")
      await dl((body as any).file?.url, (body as any).file?.aeskey, "file.bin");
    if (body.msgtype === "mixed")
      for (const it of (body as any).mixed?.items ?? [])
        if (it.msgtype === "image" && it.image?.url)
          await dl(it.image.url, it.image.aeskey, "image.jpg");

    const msg = frameToChannelMessage(body, { mediaPaths });
    for (const h of this.handlers) await h(msg);
  }

  private chatIdOf(body: BaseMessage): string {
    const isGroup = body.chattype === "group";
    return isGroup ? body.chatid ?? body.from.userid : body.from.userid;
  }

  async sendMessage(
    chatId: string,
    text: string,
    _options?: SendMessageOptions,
  ): Promise<void> {
    if (!this.client) throw new Error("wecom: 未启动");
    const frame = this.lastFrame.get(chatId);
    if (frame) {
      // 会话内流式回复：一次成型的最终帧
      const streamId = generateReqId("stream");
      await this.client.replyStream(frame, streamId, text, true);
      return;
    }
    // 无上下文帧（主动推送场景）：markdown 直发
    await this.client.sendMessage(chatId, {
      msgtype: "markdown",
      markdown: { content: text },
    });
  }
}
