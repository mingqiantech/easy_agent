import { Database } from "bun:aqlite";
import { ulid } from "ulid";
import type { ShortTermMemory } from "./short-term.js";

const DAY_MS = 86400000;

const PROMOTION = { minRecallCount: 3, minUniqueQueries: 2, minScore: 0.5 };

const FORGET = {
  shortTermMaxAgeDays: 30,
  shortTermMinRecall: 0,
};

const MEMORY_BUDGET_CHARS = 10000;
