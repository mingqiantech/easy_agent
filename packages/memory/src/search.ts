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
