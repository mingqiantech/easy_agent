import fs from "node:fs/promises";
import path from "node:path";

export interface WikiPage {
  path: string;
  title: string;
  content: string;
  category: "people" | "projects" | "concepts" | "general";
}

export class WikiManager {
  private wikiDir: string;

  constructor(workDir: string) {
    this.wikiDir = path.join(workDir, "wiki");
  }

  async init(): Promise<void> {
    for (const sub of ["people", "projects", "concepts"]) {
      await fs.mkdir(path.join(this.wikiDir, sub), { recursive: true });
    }
  }

  async getPage(relPath: string): Promise<WikiPage | null> {
    try {
      const fullPath = path.join(this.wikiDir, relPath);
      const content = await fs.readFile(fullPath, "utf-8");
      const titleMatch = content.match(/^#\s+(.+)$/m);
      return {
        path: relPath,
        title: titleMatch?.[1] ?? path.basename(relPath, ".md"),
        content,
        category: this.categorize(relPath),
      };
    } catch {
      return null;
    }
  }

  async writePage(relPath: string, content: string): Promise<void> {
    const fullPath = path.join(this.wikiDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }

  async listPages(): Promise<WikiPage[]> {
    const pages: WikiPage[] = [];
    try {
      const entries = await fs.readdir(this.wikiDir, {
        withFileTypes: true,
        recursive: true,
      });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          const relPath = path.relative(
            this.wikiDir,
            path.join(this.wikiDir, e.name),
          );
          const page = await this.getPage(relPath);
          if (page) pages.push(page);
        }
      }
    } catch {}
    return pages;
  }

  private categorize(relPath: string): WikiPage["category"] {
    if (relPath.startsWith("people/")) return "people";
    if (relPath.startsWith("projects/")) return "projects";
    if (relPath.startsWith("concepts/")) return "concepts";
    return "general";
  }
}
