import type { ChannelAdapter, ChannelMessage } from "./types.js";
import type { SessionManager } from "../session.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { UserManager } from "../user/manager.js";
import type { AuditLogger } from "../audit/index.js";

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private handlers: Array<(msg: ChannelMessage) => Promise<void>> = [];
  private userSessions = new Map<string, string>(); // "channel:userId" → sessionId
  private users?: UserManager;
  private audit?: AuditLogger;

  constructor(
    private sessions: SessionManager,
    private tools: ToolRegistry,
    private defaultModel: string,
    private workDir: string,
  ) {}

  /** Week7: 接入用户系统（未配置则保持匿名行为） */
  configureUsers(users: UserManager, audit?: AuditLogger): void {
    this.users = users;
    this.audit = audit;
  }

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
    // 群组消息：只有被 @提及 时才回复
    if (msg.isGroup && !msg.mentioned) return;

    const adapter = this.adapters.get(msg.channel);
    const reply = (text: string) =>
      adapter?.sendMessage(msg.chatId, text, {
        replyToMessageId: msg.messageId,
        parseMode: "markdown",
      });

    // Week7: 用户身份 + 状态 + 配额检查
    let userId: string | undefined;
    if (this.users) {
      const user = this.users.getOrCreateByChannel(msg.channel, msg.senderId, msg.senderName);
      userId = user.id;

      if (user.status === "suspended") {
        await reply("⛔ 账号已被暂停");
        return;
      }
      const quota = this.users.checkQuota(user.id, 1000);
      if (!quota.allowed) {
        await reply(`⚠️ ${quota.reason}`);
        return;
      }
    }

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
      // Week7: 会话归属用户
      if (this.users && userId) this.users.associateSession(sessionId, userId);
    }

    this.audit?.log({
      userId,
      sessionId,
      action: "message",
      details: { channel: msg.channel, length: msg.text.length },
    });

    try {
      const response = await this.sessions.run(sessionId, msg.text, {
        toolRegistry: this.tools,
        workDir: this.workDir,
      });

      // Week7: 记账
      if (this.users && userId) this.users.recordUsage(userId, 500);

      await reply(response);
    } catch (e: any) {
      await reply(`❌ ${e.message}`);
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
