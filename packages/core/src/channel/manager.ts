import type { ChannelAdapter, ChannelMessage } from "./types.js";
import type { SessionManager } from "../session.js";
import type { ToolRegistry } from "../tool/registry.js";

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private handlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private userSessions = new Map<string, string>(); // "channel:userId" → sessionId

  constructor(
    private sessions: SessionManager,
    private tools: ToolRegistry,
    private defaultModel: string,
    private workDir: string,
  ) {}

  /** 注册渠道适配器 */
  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.name, adapter);
    adapter.onMessage(async (msg) => {
      await this.handleMessage(msg);
    });
    console.log(`📡 Channel registered: ${adapter.name}`);
  }

  /** 启动所有渠道 */
  async startAll(): Promise<void> {
    const promises = Array.from(this.adapters.values()).map((a) => a.start());
    await Promise.all(promises);
  }

  /** 停止所有渠道 */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.adapters.values()).map((a) => a.stop());
    await Promise.all(promises);
  }

  /** 处理收到的消息 */
  private async handleMessage(msg: ChannelMessage): Promise<void> {
    // 获取或创建会话
    const key = `${msg.channel}:${msg.senderId}`;
    let sessionId = this.userSessions.get(key);

    if (!sessionId) {
      const session = this.sessions.create({
        model: this.defaultModel,
        systemPrompt: `You are a helpful AI assistant on ${msg.channel}.
User: ${msg.senderName}
Respond concisely. Use Markdown when helpful.`,
      });
      sessionId = session.id;
      this.userSessions.set(key, sessionId);
    }

    // 群组消息：只有被 @提及 时才回复
    if (msg.isGroup && !msg.mentioned) return;

    try {
      const response = await this.sessions.run(sessionId, msg.text, {
        toolRegistry: this.tools,
        workDir: this.workDir,
      });

      // 回复到原始渠道
      const adapter = this.adapters.get(msg.channel);
      if (adapter) {
        await adapter.sendMessage(msg.chatId, response, {
          replyToMessageId: msg.messageId,
          parseMode: "markdown",
        });
      }
    } catch (e: any) {
      const adapter = this.adapters.get(msg.channel);
      if (adapter) {
        await adapter.sendMessage(msg.chatId, `❌ ${e.message}`);
      }
    }
  }

  /** 获取用户会话 */
  getUserSession(channel: string, userId: string): string | undefined {
    return this.userSessions.get(`${channel}:${userId}`);
  }

  /** 重置用户会话 */
  resetUserSession(channel: string, userId: string): void {
    this.userSessions.delete(`${channel}:${userId}`);
  }
}
