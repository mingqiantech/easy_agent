import type { SessionManager } from "@easy-agent/core/session";
import type { ToolRegistry } from "@easy-agent/core/tool/registry";

export interface TelegramConfig {
  botToken: string;
  defaultModel: string;
  allowedUserIds?: number[];
  workDir?: string;
}

export class TelegramBot {
  private config: TelegramConfig;
  private sessions: SessionManager;
  private tools: ToolRegistry;
  private userSessions = new Map<number, string>(); // 用户ID到会话ID的映射

  constructor(
    config: TelegramConfig,
    sessions: SessionManager,
    tools: ToolRegistry,
  ) {
    this.config = config;
    this.sessions = sessions;
    this.tools = tools;
  }

  async start(): Promise<void> {
    const me = await this.apiCall("getMe");
    console.log(`🤖 Telegram Bot: @${me.username} (${me.first_name})`);

    let offset = 0;
    console.log("📡 Listening for messages...");

    while (true) {
      try {
        const updates = await this.apiCall("getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message"],
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message?.text) {
            await this.handleMessage(update.message);
          }
        }
      } catch (e: any) {
        console.error("Polling error:", e.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  private async handleMessage(message: any): Promise<void> {
    const userId = message.from.id;
    const text = message.text;
    const chatId = message.chat.id;

    if (
      this.config.allowedUserIds?.length &&
      !this.config.allowedUserIds.includes(userId)
    ) {
      await this.sendMessage(chatId, "⛔ 未授权");
      return;
    }

    // 命令处理
    if (text === "/start") {
      await this.sendMessage(chatId, "你好！我是 AI 助手，直接发消息跟我聊。");
      return;
    }

    if (text === "/new") {
      this.userSessions.delete(userId);
      await this.sendMessage(chatId, "✅ 新会话已创建");
      return;
    }

    // 获取或创建会话
    let sessionId = this.userSessions.get(userId);
    if (!sessionId) {
      const session = this.sessions.create({
        model: this.config.defaultModel,
        systemPrompt: `You are a helpful AI assistant on Telegram.
User: ${message.from.first_name} (${message.from.username ?? "no username"})
Respond concisely. Use Telegram Markdown when helpful.`,
      });
      sessionId = session.id;
      this.userSessions.set(userId, sessionId);
    }

    // 发送"正在输入"
    await this.apiCall("sendChatAction", { chat_id: chatId, action: "typing" });

    try {
      // 运行 Agent
      const response = await this.sessions.run(sessionId, text, {
        toolRegistry: this.tools,
        workDir: this.config.workDir,
      });

      // 发送回复（Telegram 消息上限 4096 字符）
      const chunks = this.splitMessage(response, 4096);
      for (const chunk of chunks) {
        await this.sendMessage(chatId, chunk);
      }
    } catch (e: any) {
      await this.sendMessage(chatId, `❌ ${e.message}`);
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.slice(i, i + maxLen));
    }
    return chunks;
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.apiCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    });
  }

  private async apiCall(method: string, params: any = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    const data = (await res.json()) as any;
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`);
    }
    return data.result;
  }
}
