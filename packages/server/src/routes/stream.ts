import { Hono } from "hono";
import { stream } from "hono/streaming";
import { runStream } from "@easy-agent/core/session-stream";

export function createStreamRoutes(deps: any): Hono {
  const app = new Hono();

  app.post("/api/sessions/:id/stream", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json();

    return stream(c, async (s) => {
      try {
        await runStream(deps.sessions, sessionId, body.text, {
          toolRegistry: deps.tools,
          workDir: deps.config.workspaceDir,
          onText: (text) =>
            s.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`),
          onToolCall: (name, input) =>
            s.write(
              `data: ${JSON.stringify({ type: "tool_call", name, input })}\n\n`,
            ),
          onToolResult: (name, result) =>
            s.write(
              `data: ${JSON.stringify({ type: "tool_result", name, result })}\n\n`,
            ),
          onUsage: (usage) =>
            s.write(`data: ${JSON.stringify({ type: "usage", usage })}\n\n`),
          onDone: () =>
            s.write(`data: ${JSON.stringify({ type: "done" })}\n\n`),
          onError: (error) =>
            s.write(`data: ${JSON.stringify({ type: "error", error })}\n\n`),
        });
      } catch (e: any) {
        s.write(
          `data: ${JSON.stringify({ type: "error", error: e.message })}\n\n`,
        );
      }
    });
  });

  return app;
}
