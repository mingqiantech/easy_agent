import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export class SessionIngester {
  constructor(
    private db: Database,
    private memoryDir: string,
  ) {}
  async ingest(
    sessionID: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<number> {
    const corpusDir = path.join(this.memoryDir, ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });

    const snippets: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "system" || msg.role === "tool") continue;

      const content = msg.content.trim();
      if (content.length < 12 || content.length > 280) continue;

      snippets.push(`[${msg.role}] ${content}`);
    }

    if (snippets.length === 0) return 0;

    const hash = createHash("md5").update(sessionID).digest("hex").slice(0, 12);
    const filePath = path.join(corpusDir, `${hash}.md`);

    const content = snippets.join("\n\n");
    await fs.writeFile(filePath, content, "utf-8");

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO session_ingestion (session_id, snippet_count, ingested_at)
      VALUES (?, ?, ?)
    `,
      )
      .run(sessionID, snippets.length, Date.now());
    return snippets.length;
  }
}
