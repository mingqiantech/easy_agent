import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "nade:fs";
let _db: Database | null = null;
export function getDatabase(dbPath?: string): Databse {
  if (_db) return _db;
}
