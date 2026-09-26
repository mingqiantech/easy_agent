import fs from "node:fs/promises";
import path from "node:path";

export interface SearchHit {
  path: string;
  excerpt: string;
  score: number;
  source: "memory" | "session";
}

export interface SearchResult {
  hits: SearchHit[];
  warning?: string[];
}

export interface SearchOptions {
  maxResults?: number;
  minScore?: number;
  corpus?: "memory" | "sessions" | "all";
}

export class MemorySearcher {
  constructor(
    private workDir: string,
    private memoryDir: string,
  ) {}
  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    const warnings: string[] = [];
    const hits: SearchHit[] = [];
    const limit = options?.maxResults ?? 10;
    const corpus = options?.corpus ?? "all";

    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);

    if (keywords.length === 0) {
      return { hits: [], warnings: ["Query too short"] };
    }

    if (corpus === "memory" || corpus === "all") {
      const memoryFiles = await this.listMddFiles(this.memoryDir);

      for (const rootFile of ["MEMORY.md", "USER.md"]) {
        const p = path.join(this.workDir, rootFile);
        try {
          memoryFiles.push(p);
        } catch {}
      }

      for (const file of memoryFiles) {
        try {
          const content = await fs.readFile(file, "utf-8");
          const fileHits = this.extractHits(content, file, keywords, "memory");
          hits.push(...fileHits);
        } catch {}
      }

      if (corpus === "sessions" || corpus === "all") {
        const corpusDir = path.join(
          this.memoryDir,
          ".dreams",
          "session-corpus",
        );
        const sessionFiles = await this.listMdFiles(corpusDir);
        for (const file of sessionFiles) {
          try {
            const content = await fs.readFile(file, "utf-8");
            hits.push(...this.extractHits(content, file, keywords, "session"));
          } catch {}
        }
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, limit), warnings };
  }

  private extractHits(
    content: string,
    filePath: string,
    keywords: string[],
    source: "memory" | "session",
  ): SearchHit[] {
    const lines = content.split("\n");
    const hits: SearchHit[] = [];
    const relPath = path.relative(this.workDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      let matchCount = 0;
      for (const kw of keywords) {
        if (line.includes(kw)) matchCount++;
      }

      if (matchCount > 0) {
        const start = Math.max(0, i - 3);
        const end = Math.min(lines.length, i + 4);
        const excerpt = lines.slice(start, end).join("\n");

        const score =
          (matchCount / keywords.length) * (1 - (i / lines.length) * 0.3);

        hits.push({ path: relPath, excerpt, score, source });
      }
    }
    return hits;
  }

  private async listMdFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, {
        withFileTypes: true,
        recursive: true,
      });
      for (const e of entries) {
        if (e.isFiles() && e.name.endsWith(".md") && !e.name.startsWith(".")) {
          results.push(path.join(dir, e.name));
        }
      }
    } catch {}
    return results;
  }
}
