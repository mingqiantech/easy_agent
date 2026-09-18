import { getDatabase } from "./database.js";
import { generateId, now } from "./utils.js";
import type { LLMClient } from "easy-agent/llm/client";
import type {
  Message,
  ToolDefinition,
  LLMResponse,
} from "easy-agent/schema/llm";

export interface CreateSessionOptions {
  model?: string;
  agentId?: string;
  systemPrompt?: string;
}
export interface SessionInfo {
  id: string;
  title: string | null;
  agentId: string;
  model: string;
  status: string;
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
      `INSERT INTO sessions (id, title, agent_id, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(id, null, options.agentId ?? "default", model, ts, ts);
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
      createAt: row.created_at,
      updateAt: row.updated_at,
      messageCount: countRow?.count ?? 0,
    };
  }
  list(limit: number = 50): SessionInfo[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count
         FROM sessions s
         WHERE s.status = 'active'
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      agentId: row.agent_id,
      model: row.model,
      status: row.status,
      createAt: row.created_at,
      updateAt: row.update_at,
      messageCount: row.msg_count,
    }));
  }
  delete(id: string): void {
    const db = getDatabase();
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
  list(limit: number = 50): SessionInfo[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as msg_count
         FROM sessions s
         WHERE s.status = 'active'
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as any[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      agentId: row.agent_id,
      model: row.model,
      status: row.status,
      createAt: row.create_at,
      updateAt: row.update_At,
      messageCount: row.msg_count,
    }));
  }
  delete(id: string): void {
    const db = getDatabase();
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
  async run(
    sessionId: string,
    userText: string,
    options?: {
      tools?: ToolDefinition[];
      toolExecutor?: (name: string, input: unknown) => Promise<unknown>;
      onText?: (text: string) => void;
    },
  ): Promise<string> {
    const session = this.get(sessionId);
    if (session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.addMessage(sessionId, { role: "user", content: userText });
    if (!session.title) {
      const title = userText.slice(0, 50);
      getDatabase()
        .prepare("UPDATE sessions SET title = ? WHERE id = ?")
        .run(title, sessionId);
    }
  }
  async run(
    sessionId: string,
    userText: string,
    options?: {
      tools?: ToolDefinition[];
      toolExecutor?: (name: string, input: unknown) => Promise<unknown>;
      onText?: (text: string) => void;
    },
  ): Promise<string> {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Session not found:${sessionId}`);
    this.addMessage(sessionId, { role: "user", content: userText });
    if (!session.title) {
      const title = userText.slice(0, 50);
      getDatabase()
        .prepare("UPDATE sessions SET title = ? WHERE id = ?")
        .run(title, sessionId);
    }
    const maxSteps = 20;
    let fullResponse = "";
    let step = 0;
    while (step < maxSteps) {
      step++;
      const messages = this.getMessages(sessionId);
      const response: LLMResponse = await this.llm.generate({
        model: session.model,
        messages,
        tools: options?.tools,
      });
      this.addMessage(sessionId, {
        role: "assistant",
        content: response.content,
      });
      fullResponse += response.content;
      if (options?.onText) {
        options.onText(response.content);
      }
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }
      if (!options?.toolExecutor) {
        break;
      }
      for (const toolCall of response.toolCalls) {
        let result: unknown;
        let error: string | undefined;
        try {
          result = await options.toolExecutor(toolCall.name, toolCall.input);
        } catch (e: any) {
          error = e.message;
          result = null;
        }
        const toolResultContent = JSON.stringify({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          result,
          error,
        });
        this.addMessage(sessionId, {
          role: "tool",
          content: toolResultContent,
        });
      }
    }
    return fullResponse;
  }
}
