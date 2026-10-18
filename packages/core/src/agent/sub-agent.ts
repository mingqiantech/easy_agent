import { ulid } from "ulid";
import { getDatabase } from "../database.js";
import { createRun, finishRun } from "./runs.js";
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
            `INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, total_tokens, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            sessionId,
            model,
            llmResponse.usage.promptTokens ?? 0,
            llmResponse.usage.completionTokens ?? 0,
            llmResponse.usage.totalTokens ?? 0,
            Date.now(),
          );
        }

        this.sessions.addMessage(sessionId, {
          role: "assistant",
          content: llmResponse.content,
        });
        response += llmResponse.content;

        if (!llmResponse.toolCalls?.length) {
          break;
        }

        for (const tc of llmResponse.toolCalls) {
          const result = await this.tools.execute(tc.name, tc.input, {
            sessionId,
            agentId: config.parentAgent ?? "sub-agent",
            workDir: process.cwd(),
          });
          toolCallLog.push({
            name: tc.name,
            input: tc.input,
            result: result.output,
          });
          this.sessions.addMessage(sessionId, {
            role: "tool",
            content: JSON.stringify({
              toolCallId: tc.id,
              result: result.output,
              error: result.error,
            }),
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
