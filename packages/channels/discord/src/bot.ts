import type {
  ChannelAdapter,
  ChannelMessage,
  SendMessageOptions,
} from "@easy-agent/core/channel/types";

export interface DiscordConfig {
  botToken: string;
  applicationId: string;
  allowedGuildIds?: string[];
  allowedUserIds?: string[];
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private config: DiscordConfig;
  private handlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // 获取 Gateway URL
    const res = await fetch("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${this.config.botToken}` },
    });
    const data = (await res.json()) as any;
    const url = `${data.url}/?encoding=json&v=10`;

    this.ws = new WebSocket(url);

    this.ws.onmessage = (event) => {
      const payload = JSON.parse(event.data as string);
      this.handleGatewayEvent(payload);
    };

    this.ws.onclose = () => {
      console.log("🔌 Discord WebSocket closed, reconnecting...");
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      setTimeout(() => this.start(), 3000);
    };

    console.log("🤖 Discord Bot connecting...");
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handlers.push(handler);
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void> {
    // Discord 消息上限 2000 字符
    const chunks = this.splitMessage(text, 2000);
    for (const chunk of chunks) {
      await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: chunk,
          ...(options?.replyToMessageId
            ? {
                message_reference: { message_id: options.replyToMessageId },
              }
            : {}),
        }),
      });
    }
  }

  private handleGatewayEvent(payload: any): void {
    const { op, t, d, s } = payload;

    if (s !== null) this.seq = s;

    switch (op) {
      case 10: // Hello
        this.startHeartbeat(d.heartbeat_interval);
        this.identify();
        break;
      case 11: // Heartbeat ACK
        break;
      case 0: // Dispatch
        if (t === "MESSAGE_CREATE") this.handleMessage(d);
        break;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: 1, d: this.seq }));
    }, intervalMs);
  }

  private identify(): void {
    this.ws?.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.config.botToken,
          intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
          properties: {
            os: "linux",
            browser: "easy-agent",
            device: "easy-agent",
          },
        },
      }),
    );
  }

  private async handleMessage(d: any): Promise<void> {
    // 忽略 Bot 自己的消息
    if (d.author.bot) return;

    // 权限检查
    if (
      this.config.allowedUserIds?.length &&
      !this.config.allowedUserIds.includes(d.author.id)
    )
      return;
    if (
      this.config.allowedGuildIds?.length &&
      d.guild_id &&
      !this.config.allowedGuildIds.includes(d.guild_id)
    )
      return;

    const isGroup = !!d.guild_id;
    let text = d.content;
    let mentioned = false;

    // 检查 @提及
    if (d.mentions?.some((m: any) => m.id === this.config.applicationId)) {
      mentioned = true;
      // 去掉 @mention 部分
      text = text.replace(/<@!?\d+>/g, "").trim();
    }

    // 群组消息：只有被 @提及 时才处理
    if (isGroup && !mentioned) return;

    // 处理附件（图片）
    const attachments = d.attachments?.map((a: any) => ({
      type: a.content_type?.startsWith("image")
        ? ("image" as const)
        : ("file" as const),
      url: a.url,
      mimeType: a.content_type ?? "application/octet-stream",
    }));

    const msg: ChannelMessage = {
      channel: "discord",
      senderId: d.author.id,
      senderName: d.author.global_name ?? d.author.username,
      text,
      attachments,
      messageId: d.id,
      chatId: d.channel_id,
      isGroup,
      mentioned,
      timestamp: Date.parse(d.timestamp) || Date.now(),
    };

    for (const handler of this.handlers) {
      await handler(msg);
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
      if ((current + line + "\n").length > maxLen) {
        if (current) chunks.push(current.trim());
        current = line + "\n";
      } else {
        current += line + "\n";
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }
}
