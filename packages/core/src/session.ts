import { getDatabase } from "./database.js";
import { generateId, logDebug, now } from "./utils.js";
import { needsCompaction, compactHistory } from "./compaction.js";
import type { LLMClient } from "@easy-agent/llm/client";
import type {
  Message,
  ToolDefinition,
  LLMResponse,
} from "@easy-agent/schema/llm";
import type { ToolRegistry } from "./tool/registry.js";

export interface CreateSessionOptions {
  model?: string;
  agentId?: string;
  systemPrompt?: string;
  /** 首页会话：置顶且不可删除 */
  pinned?: boolean;
  title?: string;
}
export interface SessionInfo {
  id: string;
  title: string | null;
  agentId: string;
  model: string;
  status: string;
  pinned: boolean;
  createAt: number;
  updateAt: number;
  messageCount: number;
}

export class SessionManager {
  private llm: LLMClient;
  private defaultModel: string;
  constructor(llm: LLMClient, options: { defaultModel: string }) {
    this.llm = llm;
    this.defaultModel = options.defaultModel;
  }
  create(options: CreateSessionOptions = {}): SessionInfo {
    const db = getDatabase();
    const id = generateId();
    const ts = now();
    const model = options.model ?? this.defaultModel;
    db.prepare(
      `INSERT INTO sessions (id, title, agent_id, model, status, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      id,
      options.title ?? null,
      options.agentId ?? "default",
      model,
      options.pinned ? 1 : 0,
      ts,
      ts,
    );
    if (options.systemPrompt) {
      const msgId = generateId();
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, 'system', ?, ?)`,
      ).run(msgId, id, options.systemPrompt, ts);
    }
    return this.get(id)!;
  }
  get(id: string): SessionInfo | null {
    const db = getDatabase();
    const row = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
      .get(id) as any;
    return {
      id: row.id,
      title: row.title,
      agentId: row.agent_id,
      model: row.model,
      status: row.status,
      pinned: !!row.pinned,
      createAt: row.created_at,
      updateAt: row.updated_at,
      messageCount: countRow?.count ?? 0,
    };
  }
  list(limit: number = 50, agentId?: string): SessionInfo[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count
         FROM sessions s
         WHERE s.status = 'active' AND (? IS NULL OR s.agent_id = ?)
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(agentId ?? null, agentId ?? null, limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      agentId: row.agent_id,
      model: row.model,
      status: row.status,
      pinned: !!row.pinned,
      createAt: row.created_at,
      updateAt: row.updated_at,
      messageCount: row.msg_count,
    }));
  }
  /** 删除会话；pinned（首页）不可删。返回是否真正删除。 */
  delete(id: string): boolean {
    const db = getDatabase();
    const row = db
      .prepare("SELECT pinned FROM sessions WHERE id = ?")
      .get(id) as any;
    if (!row || row.pinned) return false;
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return true;
  }
  /** 会话内切换模型（后续对话用新模型） */
  setModel(id: string, model: string): void {
    const db = getDatabase();
    db.prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?").run(
      model,
      now(),
      id,
    );
  }
  setTitle(id: string, title: string): void {
    const db = getDatabase();
    db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(
      title,
      now(),
      id,
    );
  }
  addMessage(sessionId: string, message: Message): string {
    const db = getDatabase();
    const id = generateId();
    const ts = now();
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, sessionId, message.role, message.content, ts);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
      ts,
      sessionId,
    );
    return id;
  }
  getMessages(sessionId: string): Message[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as any[];
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      id: row.id,
      createdAt: row.created_at,
    }));
  }

  /**
   * Week5 Step 2：长对话自动压缩。
   * 超过阈值时用 LLM 将旧消息摘要为一条系统消息，保留最近消息。
   */
  async compactIfNeeded(sessionId: string): Promise<boolean> {
    const messages = this.getMessages(sessionId);
    if (!needsCompaction(messages)) return false;

    const session = this.get(sessionId);
    if (!session) return false;

    console.log("📦 Compacting history...");
    const result = await compactHistory(this.llm, session.model, messages);

    const db = getDatabase();
    db.prepare(
      "DELETE FROM messages WHERE session_id = ? AND role != 'system'",
    ).run(sessionId);

    const summary = result.compacted.find(
      (m) => m.role === "system" && m.content.includes("[对话摘要]"),
    );
    if (summary) this.addMessage(sessionId, summary);
    result.compacted
      .filter((m) => m.role !== "system" && m !== summary)
      .forEach((m) => this.addMessage(sessionId, m));

    console.log(`   Compacted ${result.removed} messages into summary`);
    return true;
  }

  async run(
    sessionId: string,
    userText: string,
    options?: {
      toolRegistry?: ToolRegistry;
      workDir?: string;
      thinking?: "off" | "low" | "medium" | "high";
      onText?: (text: string) => void;
      onToolCall?: (name: string, input: unknown) => void;
      onToolResult?: (name: string, result: unknown) => void;
    },
  ): Promise<string> {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Session not found:${sessionId}`);

    const db = getDatabase();
    const workDir = options?.workDir ?? process.cwd();

    this.addMessage(sessionId, { role: "user", content: userText });
    if (!session.title) {
      db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(
        userText.slice(0, 50),
        sessionId,
      );
    }

    const toolDefs = options?.toolRegistry?.getDefinitions();
    let fullResponse = "";

    for (let step = 0; step < 20; step++) {
      await this.compactIfNeeded(sessionId);
      const messages = this.getMessages(sessionId);
      const response = await this.llm.generate({
        model: session.model,
        messages,
        tools: toolDefs,
        toolChoice: toolDefs?.length ? "auto" : undefined,
        generation:
          options?.thinking && options.thinking !== "off"
            ? { thinking: options.thinking }
            : undefined,
      });

      if (response.usage) {
        db.prepare(
          `INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          sessionId,
          session.model,
          response.usage.promptTokens ?? 0,
          response.usage.completionTokens ?? 0,
          response.usage.totalTokens ?? 0,
          now(),
        );
      }

      this.addMessage(sessionId, {
        role: "assistant",
        content: response.toolCalls?.length
          ? JSON.stringify({
              text: response.content,
              toolCalls: response.toolCalls,
            })
          : response.content,
      });
      fullResponse += response.content ?? '';
      options?.onText?.(response.content);

      if (!response.toolCalls?.length || !options?.toolRegistry) break;

      for (const tc of response.toolCalls) {
        options.onToolCall?.(tc.name, tc.input);
        const result = await options.toolRegistry.execute(tc.name, tc.input, {
          sessionId,
          agentId: session.agentId,
          workDir,
        });
        options.onToolResult?.(tc.name, result.output ?? result.error);
        this.addMessage(sessionId, {
          role: "tool",
          content: JSON.stringify({
            toolCallId: tc.id,
            toolName: tc.name,
            result: result.output,
            error: result.error,
          }),
        });
      }
    }

    return fullResponse;
  }
}
