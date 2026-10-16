import type { SessionManager } from "../session.js";
import type { ToolRegistry } from "../tool/registry.js";

export interface ChannelMessage {
  /** 渠道名称 */
  channel: string;
  /** 发送者 ID（渠道内的） */
  senderId: string;
  /** 发送者显示名 */
  senderName: string;
  /** 消息文本 */
  text: string;
  /** 附带的媒体（图片等） */
  attachments?: Array<{
    type: "image" | "file" | "audio";
    url: string;
    mimeType: string;
  }>;
  /** 渠道原始消息 ID */
  messageId: string;
  /** 回复目标（聊天/群组 ID） */
  chatId: string;
  /** 是否是群组消息 */
  isGroup: boolean;
  /** 是否被 @提及 */
  mentioned: boolean;
  /** 原始时间戳 */
  timestamp: number;
}

export interface ChannelAdapter {
  readonly name: string;

  start(): Promise<void>;

  stop(): Promise<void>;

  sendMessage(
    chatId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<void>;

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void;
}

export interface SendMessageOptions {
  replyToMessageId?: string;
  attachments?: Array<{
    type: "image" | "file";
    path: string;
  }>;
  parseMode?: "plain" | "markdown";
}

export interface ChannelConfig {
  enabled: boolean;
  adapter: string;
  config: Record<string, unknown>;
}
