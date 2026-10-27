import { getDatabase } from "./database.js";
import { generateId, logDebug, now } from "./utils.js";
import { needsCompaction, compactHistory } from "./compaction.js";
import { estimateCostUsd } from "@easy-agent/llm/pricing";
import type { LLMClient } from "@easy-agent/llm/client";
import type {
  LLMRequest,
  LLMResponse,
  Message,
  ToolDefinition,
} from "@easy-agent/schema/llm";
import type { ToolRegistry } from "./tool/registry.js";
import { pruneToolResults } from "./context.js";

/** 行→Message 的 metadata 反序列化：空/坏 JSON 当无 metadata，不阻断历史加载 */
function parseMetadata(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "string" || raw === "{}" || raw === "null") return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && Object.keys(o).length ? o : null;
  } catch {
    return null;
  }
}
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
      `INSERT INTO messages (id, session_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      message.role,
      message.content,
      message.metadata ? JSON.stringify(message.metadata) : "{}",
      ts,
    );
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
    return rows.map((row) => {
      const meta = parseMetadata(row.metadata);
      return {
        role: row.role as Message["role"],
        content: row.content,
        id: row.id,
        createdAt: row.created_at,
        ...(meta ? { metadata: meta } : {}),
      };
    });
  }

  /** 全量历史（含压缩归档消息），供 UI 展示；LLM 上下文仍用 getMessages */
  getFullMessages(sessionId: string): Message[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT id, role, content, metadata, created_at, 0 AS archived FROM messages WHERE session_id = ?
           UNION ALL
           SELECT id, role, content, metadata, created_at, 1 AS archived FROM messages_archive WHERE session_id = ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionId, sessionId) as any[];
    return rows.map((row) => {
      const meta = parseMetadata(row.metadata);
      return {
        role: row.role as Message["role"],
        content: row.content,
        id: row.id,
        createdAt: row.created_at,
        archived: !!row.archived,
        ...(meta ? { metadata: meta } : {}),
      };
    });
  }

  /** 服务启动时扫描被中断的轮次，注入续跑消息到 pending_queue；返回恢复的会话数 */
  recoverInterruptedTurns(maxResume = 2): number {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT * FROM active_turns ORDER BY last_step_at ASC")
      .all() as any[];
    let recovered = 0;
    for (const row of rows) {
      const sess = this.get(row.session_id);
      if (!sess) {
        db.prepare("DELETE FROM active_turns WHERE session_id = ?").run(row.session_id);
        continue;
      }
      if (this.isBusy(row.session_id)) continue;
      if (row.resume_count >= maxResume) {
        db.prepare("DELETE FROM active_turns WHERE session_id = ?").run(row.session_id);
        this.addMessage(sess.id, {
          role: "assistant",
          content: `⚠️ 检测到之前的任务多次中途中断（已尝试 ${row.resume_count} 次），暂停自动恢复。发送任意消息可继续。`,
        });
        continue;
      }
      // 保留台账行并递增计数（若续跑前再次崩溃，下一轮重启能看到次数）；run() 成功后 finally 统一步删除
      db.prepare(
        "UPDATE active_turns SET resume_count = resume_count + 1 WHERE session_id = ?",
      ).run(row.session_id);
      this.addMessage(sess.id, {
        role: "assistant",
        content: `♻️ 检测到服务重启打断了运行中的任务（已完成 ${row.steps_done} 步），正在自动续跑（第 ${row.resume_count + 1} 次尝试）...`,
      });
      this.enqueuePending(sess.id, "【系统恢复】上一轮任务因服务重启被中断。请根据对话中已有的进度继续完成之前的任务，不要重复已完成的步骤；先简要说明在做什么再继续。若任务实际已完成，确认后收尾即可。");
      recovered++;
    }
    return recovered;
  }

  /**
   * Week5 Step 2：长对话自动压缩。
   * 超过阈值时用 LLM 将旧消息摘要为一条系统消息，保留最近消息。
   * 被摘要折叠的旧消息不再删除，而是移入 messages_archive（UI 仍可见）。
   */
  async compactIfNeeded(sessionId: string): Promise<boolean> {
    const messages = this.getMessages(sessionId);
    if (!needsCompaction(messages)) return false;

    const session = this.get(sessionId);
    if (!session) return false;

    console.log("📦 Compacting history...");
    const db = getDatabase();
    const result = await compactHistory(this.llm, session.model, messages);

    // 保留段（未折叠的最近消息，按原 id 识别）原地不动；被折叠的旧消息归档
    const keepIds = new Set(
      result.compacted
        .filter((m) => m.role !== "system")
        .map((m: any) => m.id)
        .filter(Boolean),
    );
    const toArchive = (messages as any[]).filter(
      (m) => m.role !== "system" && m.id && !keepIds.has(m.id),
    );
    const summary = result.compacted.findLast(
      (m) => m.role === "system" && m.content.includes("[对话摘要]"),
    ); // findLast：取本次新生成的摘要（systemMsgs 在前，可能含历史摘要）
    const ts = now();
    const keptTimestamps = [...keepIds].length
      ? (messages as any[])
          .filter((m) => m.id && keepIds.has(m.id))
          .map((m) => m.createdAt ?? ts)
      : [];
    // 摘要插在保留段之前，保证 LLM 上下文顺序：…旧系统消息 → 摘要 → 最近消息
    const summaryTs = keptTimestamps.length
      ? Math.max(0, Math.min(...keptTimestamps) - 1)
      : ts;

    db.transaction(() => {
      if (toArchive.length) {
        const ins = db.prepare(
          `INSERT OR REPLACE INTO messages_archive
           (id, session_id, role, content, metadata, created_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const del = db.prepare("DELETE FROM messages WHERE id = ?");
        for (const m of toArchive) {
          ins.run(
            m.id,
            sessionId,
            m.role,
            m.content,
            m.metadata ? JSON.stringify(m.metadata) : "{}",
            m.createdAt ?? ts,
            ts,
          );
          del.run(m.id);
        }
      }
      if (summary) {
        const exists = (this.getMessages(sessionId) as any[]).some(
          (m) => m.role === "system" && m.content === summary.content,
        );
        if (!exists) {
          db.prepare(
            `INSERT INTO messages (id, session_id, role, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(generateId(), sessionId, summary.role, summary.content, summaryTs);
        }
      }
    })();

    console.log(`   Compacted ${toArchive.length} messages into summary`);
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
      /** 每轮动态附加的 system 提示（注入在头部 system 块之后，前缀缓存友好） */
      extraSystem?: string;
      /** 本轮用户消息附带的图片（服务端 uploads 文件引用，存 metadata.images） */
      images?: Array<{ file: string; mimeType: string; name?: string }>;
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
    // 轮次台账：崩溃时 finally 不执行，残留行供重启后恢复
    db.prepare(
      `INSERT INTO active_turns (session_id, started_at, last_step_at, steps_done, resume_count)
       VALUES (?, ?, ?, 0, COALESCE((SELECT resume_count FROM active_turns WHERE session_id = ?), 0))
       ON CONFLICT(session_id) DO UPDATE SET started_at = excluded.started_at,
         last_step_at = excluded.last_step_at, steps_done = 0`,
    ).run(sessionId, now(), now(), sessionId);
    const ctrl = new AbortController();
    this.controllers.set(sessionId, ctrl);
    let fullResponse = "";
    try {
      this.preloadQueue(sessionId);
      // userText 为 null 的恢复轮：以遗留队列头一条启动（否则循环空转）
      let nextText: string | null = userText ?? this.takeQueued(sessionId);
      while (nextText !== null) {
        if (nextText || options?.images?.length) {
          this.addMessage(sessionId, {
            role: "user",
            content: nextText || "",
            // 图片只随本轮首条用户消息入库（排队转向消息不带图）
            ...(nextText === userText && options?.images?.length
              ? { metadata: { images: options.images } }
              : {}),
          });
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
        let emptyRetries = 0;
        let endedEmpty = false;
        // 步数封顶标记：最后一轮以工具调用结束时为 true → 循环后补一次无工具收口，
        // 否则用户看到“工具跑完但没有任何回复”（2026-10-27 症状修复）
        let cappedOnTools = false;

        for (let step = 0; step < 20; step++) {
          db.prepare(
            "UPDATE active_turns SET last_step_at = ?, steps_done = ? WHERE session_id = ?",
          ).run(now(), step, sessionId);
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
          // extraSystem 插入位置：头部连续 system 块之后（基础 prompt 前缀不变，
          // 开关/提示切换只失效到 hint 层，不连坐底层 system 缓存）
          const reqMessages = options?.extraSystem
            ? (() => {
                const i = messages.findIndex((m) => m.role !== "system");
                const at = i < 0 ? messages.length : i;
                return [...messages.slice(0, at), { role: "system" as const, content: options.extraSystem! }, ...messages.slice(at)];
              })()
            : messages;
          const request: LLMRequest = {
            model: session.model,
            messages: reqMessages,
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
            const costUsd = estimateCostUsd(session.model, response.usage);
            db.prepare(
              `INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, cached_write_tokens, cost_usd, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              sessionId,
              session.model,
              response.usage.promptTokens ?? 0,
              response.usage.completionTokens ?? 0,
              response.usage.totalTokens ?? 0,
              response.usage.cacheReadTokens ?? 0,
              response.usage.cacheWriteTokens ?? 0,
              costUsd ?? null,
              now(),
            );
          }

          const hasPayload =
            (response.content ?? "") !== "" || !!response.toolCalls?.length;
          // 空响应（网关流中断/安全过滤/思考吃掉 max_tokens）→ 静默重试一次；
          // 此前直接 break → 本轮零输出，用户端表现为“没有下文”
          if (!hasPayload && !ctrl.signal.aborted) {
            if (emptyRetries < 1) {
              emptyRetries++;
              logDebug(`⚠️ 空响应（step ${step}）→ 重试 #${emptyRetries}`);
              step--;
              continue;
            }
            endedEmpty = true; // 重试后仍空：标记本轮无终文，循环后补占位
          }
          if (hasPayload && (!ctrl.signal.aborted || (response.content ?? "") !== "")) {
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

          if (!response.toolCalls?.length || !options?.toolRegistry) {
            cappedOnTools = false;
            break;
          }
          cappedOnTools = true;
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
        // 本轮终文为空（重试后仍空，非中断）→ 补占位 assistant，避免“没有下文”
        if (!turnAborted && !ctrl.signal.aborted && endedEmpty) {
          this.addMessage(sessionId, {
            role: "assistant",
            content:
              "⚠️ 模型本轮未返回内容（已重试一次，可能网关流中断/安全过滤），请重发或换个说法。",
          });
        }

        // 20 步工具轮次用尽且最后一步停在工具上 → 无工具收口调用：
        // 把当前进展总结成正式回复（流式透出），否则前端只有工具卡片没有终文
        if (!turnAborted && !ctrl.signal.aborted && cappedOnTools) {
          try {
            await this.compactIfNeeded(sessionId);
            const wrapMessages = pruneToolResults(this.getMessages(sessionId));
            const wrapReq: LLMRequest = {
              model: session.model,
              messages: [
                ...wrapMessages,
                {
                  role: "user",
                  content:
                    "（系统内部指令，勿展示给用户）本轮工具调用步数已达上限。不要再请求任何工具，基于上方已有信息给出阶段性总结：完成了什么、还缺什么、建议下一步。用用户语言。",
                },
              ],
              signal: ctrl.signal,
            };
            const wrap = options?.onEvent
              ? await this.stepStream(wrapReq, options.onEvent)
              : await this.llm.generate(wrapReq);
            if (wrap.usage) {
              const costUsd = estimateCostUsd(session.model, wrap.usage);
              db.prepare(
                `INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, cached_read_tokens, cached_write_tokens, cost_usd, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                sessionId,
                session.model,
                wrap.usage.promptTokens ?? 0,
                wrap.usage.completionTokens ?? 0,
                wrap.usage.totalTokens ?? 0,
                wrap.usage.cacheReadTokens ?? 0,
                wrap.usage.cacheWriteTokens ?? 0,
                costUsd ?? null,
                now(),
              );
            }
            if (wrap.content) {
              this.addMessage(sessionId, { role: "assistant", content: wrap.content });
              fullResponse += wrap.content;
            } else {
              const ph = "⏸ 本轮工具步数已达上限（20），收口总结未返回内容。回复“继续”可接着跑。";
              this.addMessage(sessionId, {
                role: "assistant",
                content: ph,
              });
              fullResponse += ph;
            }
          } catch {
            const ph = "⏸ 本轮工具步数已达上限（20）。回复“继续”可接着跑。";
            if (!savedAssistant)
              this.addMessage(sessionId, {
                role: "assistant",
                content: ph,
              });
            fullResponse += ph;
          }
        }

        // 队列尾部：本轮答完后仍有排队消息 → 作为下一用户轮继续运行
        const tail = this.takeQueued(sessionId);
        nextText = tail;
        if (nextText !== null && fullResponse) fullResponse += "\n\n";
      }
      return fullResponse;
    } finally {
      db.prepare("DELETE FROM active_turns WHERE session_id = ?").run(sessionId);
      this.running.delete(sessionId);
      this.queues.delete(sessionId);
      this.controllers.delete(sessionId);
    }
  }
}
