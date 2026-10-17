import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 隔离状态目录（本文件最先初始化 db 单例，其余 week* 测试共用 tmp 库）
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-w12-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "../src/database.js";
import { MigrationManager } from "../src/migration/index.js";
import { localStressTest } from "../src/benchmark/stress.js";

describe("Week12: MigrationManager", () => {
  it("registers, migrates incrementally, idempotent on second run", () => {
    const db = new Database(":memory:");
    const mgr = new MigrationManager(db);

    mgr.register({
      version: 1,
      name: "create_widgets",
      up: ["CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"],
    });
    mgr.register({
      version: 2,
      name: "add_owner",
      up: ["ALTER TABLE widgets ADD COLUMN owner TEXT"],
    });

    expect(mgr.currentVersion()).toBe(0);
    expect(mgr.pending().length).toBe(2);

    const report = mgr.migrate();
    expect(report.applied).toBe(2);
    expect(report.from).toBe(0);
    expect(report.to).toBe(2);
    expect(mgr.pending().length).toBe(0);

    // 重复执行不重跑
    expect(mgr.migrate().applied).toBe(0);

    // v2 生效后 owner 列可用
    db.prepare("INSERT INTO widgets (id, name, owner) VALUES (1, 'w1', 'alice')").run();

    // 重复版本号拒绝
    expect(() => mgr.register({ version: 1, name: "dup", up: ["SELECT 1"] })).toThrow(
      "Duplicate migration version",
    );

    db.close();
  });

  it("export/import roundtrip between two databases", async () => {
    const db1 = new Database(":memory:");
    const src = new MigrationManager(db1);
    src.register({
      version: 1,
      name: "base",
      up: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)"],
    });
    src.migrate();
    db1.prepare("INSERT INTO notes (id, text) VALUES (1, 'hello')").run();
    db1.prepare("INSERT INTO notes (id, text) VALUES (2, 'world')").run();

    const dumpPath = path.join(TEST_DIR, "dump.json");
    const ex = await src.exportJson(dumpPath);
    expect(ex.tables).toBe(1);
    expect(ex.rows).toBe(2);

    const db2 = new Database(":memory:");
    const dst = new MigrationManager(db2);
    dst.register({
      version: 1,
      name: "base",
      up: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)"],
    });
    dst.migrate();

    const im = await dst.importJson(dumpPath);
    expect(im.tables).toBe(1);
    expect(im.rows).toBe(2);

    const rows = db2.prepare("SELECT * FROM notes ORDER BY id").all() as any[];
    expect(rows[0].text).toBe("hello");
    expect(rows[1].text).toBe("world");
    expect(dst.currentVersion()).toBe(1);

    db1.close();
    db2.close();
  });
});

describe("Week12: localStressTest", () => {
  beforeAll(() => {
    getDatabase(process.env.EASY_AGENT_DB_PATH!);
  });

  it("runs concurrent db writes/reads with zero failures", async () => {
    const result = await localStressTest({ concurrentUsers: 4, opsPerUser: 10 });

    expect(result.totalOps).toBe(40);
    expect(result.failedOps).toBe(0);
    expect(result.successfulOps).toBe(40);
    expect(result.errors.length).toBe(0);
    expect(result.avgLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.throughputOpsPerSec).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves no leftover stress sessions", () => {
    const row = getDatabase()
      .prepare("SELECT COUNT(*) as c FROM sessions WHERE agent_id = 'stress'")
      .get() as any;
    expect(row?.c ?? 0).toBe(0);
  });
});
