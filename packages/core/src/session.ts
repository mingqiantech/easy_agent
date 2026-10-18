import { getDatabase } from "./database.js";
import { generateId, logDebug, now } from "./utils.js";
import { needsCompaction, compactHistory } from "./compaction.js";
import type { LLMClient } from "@easy-agent/llm/client";
import type {
  LLMRequest,
  LLMResponse,
  Message,
  ToolDefinition,
} from "@easy-agent/schema/llm";
import type { ToolRegistry } from "./tool/registry.js";
import { pruneToolResults } from "./context.js";
import { maskSecrets } from "./secrets-mask.js";

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
  private running = new Set<string>();
  private queues = new Map<string, { id: number; text: string }[]>();
  private controllers = new Map<string, AbortController>();
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
           AND s.id NOT IN (SELECT child_session_id FROM sub_agent_runs)
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
    db.prepare("DELETE FROM pending_queue WHERE session_id = ?").run(id);
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
  /** 会话是否正在运行（排队/转向判断） */
  isBusy(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** 把消息排入进行中会话的队列（落库持久化）；没在跑则返回 false（调用方直接 run） */
  queueMessage(sessionId: string, text: string): boolean {
    if (!this.running.has(sessionId)) return false;
    const id = this.enqueuePending(sessionId, text);
    const q = this.queues.get(sessionId);
    if (q) q.push({ id, text });
    else this.queues.set(sessionId, [{ id, text }]);
    return true;
  }

  /** 排队消息直接落库（重启不丢），返回行 id */
  enqueuePending(sessionId: string, text: string): number {
    const res = getDatabase()
      .prepare(
        "INSERT INTO pending_queue (session_id, text, created_at) VALUES (?, ?, ?)",
      )
      .run(sessionId, text, now());
    return Number(res.lastInsertRowid);
  }

  /** 取队列头并删除其持久化行 */
  private takeQueued(sessionId: string): string | null {
    const q = this.queues.get(sessionId);
    if (!q?.length) return null;
    const item = q.shift()!;
    getDatabase()
      .prepare("DELETE FROM pending_queue WHERE id = ?")
      .run(item.id);
    return item.text;
  }

  /** run 启动时载入该会话遗留的 pending 行（崩溃/重启恢复的关键） */
  private preloadQueue(sessionId: string): void {
    if (this.queues.has(sessionId)) return;
    const rows = getDatabase()
      .prepare(
        "SELECT id, text FROM pending_queue WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as any[];
    if (rows.length)
      this.queues.set(sessionId, rows.map((r) => ({ id: Number(r.id), text: r.text })));
  }

  /** 任意步中断：中止进行中会话（LLM 请求与子进程随之终止），返回是否命中 */
  abort(sessionId: string): boolean {
    const ctrl = this.controllers.get(sessionId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
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

  /** 流式单步：消费 llm.stream，收集文本/工具调用/usage，增量回调事件；abort 时返回已产出部分 */
  private async stepStream(
    request: LLMRequest,
    onEvent: (e: { type: string; text?: string; name?: string }) => void,
  ): Promise<LLMResponse> {
    let content = "";
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    const pending = new Map<string, { name: string; args: string }>();
    let usage: LLMResponse["usage"] | undefined;
    try {
      for await (const ev of this.llm.stream(request)) {
        if (ev.type === "text") {
          if (ev.text) {
            content += ev.text;
            onEvent({ type: "text", text: ev.text });
          }
        } else if (ev.type === "tool_call_start") {
          pending.set(ev.id, { name: ev.name, args: "" });
          onEvent({ type: "tool_start", name: ev.name });
        } else if (ev.type === "tool_call_delta") {
          const pt = pending.get(ev.id);
          if (pt && ev.input) pt.args += ev.input;
        } else if (ev.type === "tool_call_end") {
          const pt = pending.get(ev.id);
          if (pt) {
            pending.delete(ev.id);
            let input: unknown = {};
            try {
              input = JSON.parse(pt.args);
            } catch {
              input = {};
            }
            toolCalls.push({ id: ev.id, name: pt.name, input });
          }
        } else if (ev.type === "usage") {
          usage = ev.usage;
        } else if (ev.type === "error") {
          throw new Error(String(ev.error ?? "LLM stream error"));
        }
      }
    } catch (e: any) {
      if (!request.signal?.aborted) throw e;
    }
    return {
      content,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
    } as LLMResponse;
  }

  async run(
    sessionId: string,
    userText: string | null,
    options?: {
      toolRegistry?: ToolRegistry;
      workDir?: string;
      thinking?: "off" | "low" | "medium" | "high";
      onText?: (text: string) => void;
      onToolCall?: (name: string, input: unknown) => void;
      onToolResult?: (name: string, result: unknown) => void;
      onEvent?: (e: { type: string; text?: string; name?: string }) => void;
    },
  ): Promise<string> {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Session not found：${sessionId}`);

    const db = getDatabase();
    const workDir = options?.workDir ?? process.cwd();

    this.running.add(sessionId);
    const ctrl = new AbortController();
    this.controllers.set(sessionId, ctrl);
    let fullResponse = "";
    try {
      this.preloadQueue(sessionId);
      // userText 为 null 的恢复轮：以遗留队列头一条启动（否则循环空转）
      let nextText: string | null = userText ?? this.takeQueued(sessionId);
      while (nextText !== null) {
        if (nextText) {
          this.addMessage(sessionId, { role: "user", content: nextText });
          if (!session.title) {
            const t = nextText.slice(0, 50);
            db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(
              t,
              sessionId,
            );
            session.title = t;
          }
        }

        const toolDefs = options?.toolRegistry?.getDefinitions();
        let turnAborted = false;
        let savedAssistant = false;

        for (let step = 0; step < 20; step++) {
          if (ctrl.signal.aborted) {
            turnAborted = true;
            break;
          }

          // 转向（steering）：运行中新排入（含重启恢复）的消息并入当前上下文
          let q: string | null;
          while ((q = this.takeQueued(sessionId)) !== null) {
            this.addMessage(sessionId, { role: "user", content: q });
          }

          await this.compactIfNeeded(sessionId);
          const messages = pruneToolResults(this.getMessages(sessionId));
          const request: LLMRequest = {
            model: session.model,
            messages,
            tools: toolDefs,
            toolChoice: toolDefs?.length ? "auto" : undefined,
            generation:
              options?.thinking && options.thinking !== "off"
                ? { thinking: options.thinking }
                : undefined,
            signal: ctrl.signal,
          };
          let response: LLMResponse;
          try {
            response = options?.onEvent
              ? await this.stepStream(request, options.onEvent)
              : await this.llm.generate(request);
          } catch (e: any) {
            if (ctrl.signal.aborted) {
              turnAborted = true;
              break;
            }
            throw e;
          }

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

          if (!ctrl.signal.aborted || (response.content ?? "") !== "") {
            this.addMessage(sessionId, {
              role: "assistant",
              content: response.toolCalls?.length
                ? JSON.stringify({
                    text: response.content,
                    toolCalls: response.toolCalls,
                  })
                : response.content,
            });
            savedAssistant = true;
          }
          fullResponse += response.content ?? "";
          options?.onText?.(response.content);

          if (!response.toolCalls?.length || !options?.toolRegistry) break;

          for (const tc of response.toolCalls) {
            options.onToolCall?.(tc.name, tc.input);
            const result = await options.toolRegistry.execute(tc.name, tc.input, {
              sessionId,
              agentId: session.agentId,
              workDir,
              abortSignal: ctrl.signal,
            });
            options.onToolResult?.(tc.name, result.output ?? result.error);
            // 密钥屏蔽：工具输出落库前替换已知密钥值，模型/界面/历史都不见明文
            this.addMessage(sessionId, {
              role: "tool",
              content: maskSecrets(
                JSON.stringify({
                  toolCallId: tc.id,
                  toolName: tc.name,
                  result: result.output,
                  error: result.error,
                }),
              ),
            });
          }
          if (ctrl.signal.aborted) {
            turnAborted = true;
            break;
          }
        }

        if (turnAborted || ctrl.signal.aborted) {
          if (!savedAssistant)
            this.addMessage(sessionId, {
              role: "assistant",
              content: "⏹ 已中断",
            });
          break; // 不再消费队列尾部：剩余排队消息保留在库中下次续跑
        }

        // 队列尾部：本轮答完后仍有排队消息 → 作为下一用户轮继续运行
        const tail = this.takeQueued(sessionId);
        nextText = tail;
        if (nextText !== null && fullResponse) fullResponse += "\n\n";
      }
      return fullResponse;
    } finally {
      this.running.delete(sessionId);
      this.queues.delete(sessionId);
      this.controllers.delete(sessionId);
    }
  }
}
