import { ulid } from "ulid";
import { getDatabase } from "../database.js";
import { createRun, finishRun } from "./runs.js";
import { estimateCostUsd } from "@easy-agent/llm/pricing";
import { maskSecrets } from "../secrets-mask.js";
import type { SessionManager } from "../session.js";
import type { ToolRegistry } from "../tool/registry.js";
import type { LLMClient } from "@easy-agent/llm/client";

export interface SubAgentConfig {
  model?: string;
  systemPrompt: string;
  allowedTools?: string[];
  maxSteps?: number;
  parentSessionId?: string;
  parentAgent?: string;
  /** 子会话归属的 agent（跨 agent 控制时=目标 agent 名） */
  agentId?: string;
  workDir?: string;
}

export interface SubAgentResult {
  sessionId: string;
  response: string;
  steps: number;
  toolCalls: Array<{ name: string; input: unknown; result: unknown }>;
}

export class SubAgentManager {
  constructor(
    private sessions: SessionManager,
    private tools: ToolRegistry,
    private llm: LLMClient,
    private defaultModel: string,
  ) {}

  spawn(config: SubAgentConfig): { sessionId: string } {
    const session = this.sessions.create({
      model: config.model ?? this.defaultModel,
      agentId: config.agentId ?? "sub-agent",
      systemPrompt: config.systemPrompt,
    });

    return { sessionId: session.id };
  }

  async run(
    sessionId: string,
    task: string,
    config: SubAgentConfig,
  ): Promise<SubAgentResult> {
    const db = getDatabase();
    const model = config.model ?? this.defaultModel;
    const runId = createRun({
      parentSessionId: config.parentSessionId,
      parentAgent: config.parentAgent,
      childSessionId: sessionId,
      targetAgent: config.agentId,
      task,
      model,
    });
    db.prepare(
      "UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL",
    ).run(`[子] ${task.slice(0, 40)}`, sessionId);

    const toolDefs = config.allowedTools
      ? this.tools.list().filter((t) => config.allowedTools?.includes(t.name))
      : this.tools.list();

    const toolRegistryDefs = toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t as any).inputSchema,
    }));

    let response = "";
    let steps = 0;
    let totalTokens = 0;
    const toolCallLog: SubAgentResult["toolCalls"] = [];
    const maxSteps = config.maxSteps ?? 10;

    this.sessions.addMessage(sessionId, { role: "user", content: task });

    try {
      for (let step = 0; step < maxSteps; step++) {
        steps++;
        const messages = this.sessions.getMessages(sessionId);
        const llmResponse = await this.llm.generate({
          model,
          messages,
          tools: toolRegistryDefs as any,
          toolChoice: "auto",
        });

        if (llmResponse.usage) {
          totalTokens += llmResponse.usage.totalTokens ?? 0;
          db.prepare(
            `INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            sessionId,
            model,
            llmResponse.usage.promptTokens ?? 0,
            llmResponse.usage.completionTokens ?? 0,
            llmResponse.usage.totalTokens ?? 0,
            estimateCostUsd(model, llmResponse.usage) ?? null,
            Date.now(),
          );
        }

        this.sessions.addMessage(sessionId, {
          role: "assistant",
          content: llmResponse.toolCalls?.length
            ? JSON.stringify({
                text: llmResponse.content,
                toolCalls: llmResponse.toolCalls,
              })
            : llmResponse.content,
        });
        response += llmResponse.content;

        if (!llmResponse.toolCalls?.length) {
          break;
        }

        for (const tc of llmResponse.toolCalls) {
          const result = await this.tools.execute(tc.name, tc.input, {
            sessionId,
            agentId: config.parentAgent ?? "sub-agent",
            // 继承发起方 agent 的隔离工作区（memory_search 分发/文件工具都靠它）；
            // 缺旧行为 process.cwd() 会把子任务打到仓库目录（2026-10-30 体检发现）
            workDir: config.workDir ?? process.cwd(),
          });
          toolCallLog.push({
            name: tc.name,
            input: tc.input,
            result: result.output,
          });
          this.sessions.addMessage(sessionId, {
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
      }
      finishRun(runId, "ok", {
        steps,
        toolCalls: toolCallLog.length,
        totalTokens,
      });
    } catch (e) {
      finishRun(runId, "error", {
        steps,
        toolCalls: toolCallLog.length,
        totalTokens,
      });
      throw e;
    }
    return { sessionId, response, steps, toolCalls: toolCallLog };
  }

  async runParallel(
    tasks: Array<{ task: string; config: SubAgentConfig }>,
  ): Promise<SubAgentResult[]> {
    const promises = tasks.map(({ task, config }) => {
      const { sessionId } = this.spawn(config);
      return this.run(sessionId, task, config);
    });
    return Promise.all(promises);
  }
}
