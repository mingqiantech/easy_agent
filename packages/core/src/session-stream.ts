import type { SessionManager } from "./session.js";
import type { ToolRegistry } from "./tool/registry.js";
import type { LLMStreamEvent } from "@easy-agent/schema/llm";

export interface StreamCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, result: unknown) => void;
  onUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
}

/**
 * 流式运行会话 — 逐字输出 + 实时工具调用
 */
export async function runStream(
  sessions: SessionManager,
  sessionId: string,
  userText: string,
  options: { toolRegistry?: ToolRegistry; workDir?: string } & StreamCallbacks,
): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  sessions.addMessage(sessionId, { role: "user", content: userText });

  const toolDefs = options?.toolRegistry?.getDefinitions();
  const workDir = options.workDir ?? process.cwd();
  let fullResponse = "";

  for (let step = 0; step < 20; step++) {
    const messages = sessions.getMessages(sessionId);

    // 流式调用
    let assistantText = "";
    let toolCalls: any[] = [];

    for await (const event of sessions["llm"].stream({
      model: session.model,
      messages,
      tools: toolDefs,
      toolChoice: toolDefs?.length ? "auto" : undefined,
    })) {
      switch (event.type) {
        case "text":
          assistantText += event.text;
          options.onText?.(event.text);
          break;
        case "tool_call_start":
          toolCalls.push({ id: event.id, name: event.name, input: "" });
          options.onToolCall?.(event.name, "");
          break;
        case "tool_call_delta":
          const tc = toolCalls.find((t) => t.id === event.id);
          if (tc) tc.input += event.input;
          break;
        case "tool_call_end":
          break;
        case "usage":
          options.onUsage?.(event.usage);
          break;
        case "error":
          options.onError?.(event.error);
          break;
        case "done":
          break;
      }
    }

    // 保存助手消息
    sessions.addMessage(sessionId, {
      role: "assistant",
      content: assistantText,
    });
    fullResponse += assistantText;

    // 没有工具调用 → 结束
    if (!toolCalls.length || !options?.toolRegistry) {
      options.onDone?.();
      break;
    }

    // 解析工具输入
    for (const tc of toolCalls) {
      try {
        tc.input = JSON.parse(tc.input);
      } catch {}
    }

    // 执行工具
    for (const tc of toolCalls) {
      const result = await options.toolRegistry!.execute(tc.name, tc.input, {
        sessionId,
        agentId: session.agentId,
        workDir,
      });
      options.onToolResult?.(tc.name, result.output ?? result.error);
      sessions.addMessage(sessionId, {
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
