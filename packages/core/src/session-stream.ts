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
  options: {
    toolRegistry?: ToolRegistry;
    workDir?: string;
    /** 图片附件引用（已落盘 uploads） */
    images?: Array<{ file: string; mimeType: string; name?: string }>;
  } & StreamCallbacks,
): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  sessions.addMessage(sessionId, {
    role: "user",
    content: userText,
    ...(options.images?.length ? { metadata: { images: options.images } } : {}),
  });

  const toolDefs = options?.toolRegistry?.getDefinitions();
  const workDir = options.workDir ?? process.cwd();
  let fullResponse = "";
  // 步数封顶标记（同 session.run 修复）：卡在工具轮上结束时补一次无工具收口
  let cappedOnTools = false;

  for (let step = 0; step < 20; step++) {
    // Week5 Step 2：长对话自动压缩（先压缩再取消息）
    await sessions.compactIfNeeded(sessionId);
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
      cappedOnTools = false;
      options.onDone?.();
      break;
    }
    cappedOnTools = true;

    // 解析工具输入
    for (const tc of toolCalls) {
      try {
        tc.input = JSON.parse(tc.input);
      } catch {}
    }

    // 执行工具（同轮并行，结果按原序落库；与 session.run 一致）
    for (const tc of toolCalls) options.onToolCall?.(tc.name, tc.input);
    const results = await Promise.all(
      toolCalls.map((tc) =>
        options.toolRegistry!.execute(tc.name, tc.input, {
          sessionId,
          agentId: session.agentId,
          workDir,
        }).catch((e: any) => ({ output: null, error: String(e?.message ?? e) })),
      ),
    );
    for (let ti = 0; ti < toolCalls.length; ti++) {
      const tc = toolCalls[ti];
      const result = results[ti];
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

  // 20 步用尽卡在工具轮 → 无工具收口：流式总结当前进展，保证 onDone 必达，
  // 否则前端永远停在“跑完工具没有回复”
  if (cappedOnTools) {
    let wrapText = "";
    try {
      await sessions.compactIfNeeded(sessionId);
      const wrapMessages: Array<{ role: string; content: string }> = [
        ...sessions.getMessages(sessionId),
        {
          role: "user",
          content:
            "（系统内部指令，勿展示给用户）本轮工具调用步数已达上限。不要再请求任何工具，基于上方已有信息给出阶段性总结：完成了什么、还缺什么、建议下一步。用用户语言。",
        },
      ];
      for await (const event of sessions["llm"].stream({
        model: session.model,
        messages: wrapMessages as never,
      })) {
        if (event.type === "text" && event.text) {
          wrapText += event.text;
          options.onText?.(event.text);
        }
      }
    } catch {
      // 收口失败落入占位
    }
    const finalText = wrapText || "⏸ 本轮工具步数已达上限（20）。回复“继续”可接着跑。";
    sessions.addMessage(sessionId, { role: "assistant", content: finalText });
    fullResponse += finalText;
  }
  options.onDone?.();
  return fullResponse;
}
