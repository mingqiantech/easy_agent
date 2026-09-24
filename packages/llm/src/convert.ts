import type { Message } from "@easy-agent/schema/llm";
export function toCoreMessages(messages: Message[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(m.content);
      } catch {}
      if (Array.isArray(parsed?.toolCalls) && parsed.toolCalls.length) {
        const parts: any[] = [];
        if (parsed.text) parts.push({ type: "text", text: parsed.text });
        for (const tc of parsed.toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.input ?? {},
          });
        }
        out.push({ role: "assistant", content: parts });
      } else {
        out.push({ role: "assistant", content: parsed?.text ?? m.content });
      }
      continue;
    }
    if (m.role === "tool") {
      let parsed: any = null;
      try {
        parsed = JSON.parse(m.content);
      } catch {}
      if (parsed?.toolCallId) {
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: parsed.toolCallId,
              toolName: parsed.toolName,
              result: parsed.error ? { error: parsed.error } : parsed.result,
              ...(parsed.error ? { isError: true } : {}),
            },
          ],
        });
      }
    }
  }
  return out;
}
