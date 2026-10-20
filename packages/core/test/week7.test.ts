import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 隔离状态目录，避免污染真实数据库
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-w7-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "../src/database.js";
import { UserManager } from "../src/user/manager.js";
import { AuditLogger } from "../src/audit/index.js";
import { BackupManager } from "../src/backup/index.js";

describe("Week7: UserManager", () => {
  let users: UserManager;

  beforeAll(() => {
    getDatabase(process.env.EASY_AGENT_DB_PATH!);
    users = new UserManager();
  });

  it("creates a user with default quota", () => {
    const user = users.create({ username: "alice", displayName: "Alice" });
    expect(user.role).toBe("user");
    expect(user.status).toBe("active");

    const quota = users.getQuota(user.id);
    expect(quota).not.toBeNull();
    expect(quota!.dailyTokenLimit).toBe(100000);
    expect(quota!.dailyRequestsUsed).toBe(0);
  });

  it("maps channel identity to internal user (auto-register)", () => {
    const first = users.getOrCreateByChannel("telegram", "12345", "zero");
    const again = users.getOrCreateByChannel("telegram", "12345");
    expect(again.id).toBe(first.id);
  });

  it("enforces daily quota", () => {
    const user = users.create({ username: "quota-test" });
    for (let i = 0; i < 100; i++) users.recordUsage(user.id, 10);
    const check = users.checkQuota(user.id, 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("请求上限");
  });

  it("blocks token quota overflow", () => {
    const user = users.create({ username: "token-quota" });
    users.recordUsage(user.id, 99500);
    const check = users.checkQuota(user.id, 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("token");
  });

  it("suspends and unsusends", () => {
    const user = users.create({ username: "bob" });
    users.suspend(user.id);
    expect(users.get(user.id)!.status).toBe("suspended");
    users.unsuspend(user.id);
    expect(users.get(user.id)!.status).toBe("active");
  });

  it("associates sessions with users and verifies ownership", () => {
    const u1 = users.create({ username: "owner" });
    const u2 = users.create({ username: "other" });
    getDatabase()
      .prepare(
        `INSERT INTO sessions (id, title, agent_id, model, status, created_at, updated_at)
         VALUES ('s1', NULL, 'default', 'test', 'active', ?, ?)`,
      )
      .run(Date.now(), Date.now());

    users.associateSession("s1", u1.id);
    expect(users.verifySessionOwnership("s1", u1.id)).toBe(true);
    expect(users.verifySessionOwnership("s1", u2.id)).toBe(false);
  });
});

describe("Week7: AuditLogger", () => {
  let audit: AuditLogger;
  let users: UserManager;

  beforeAll(() => {
    users = new UserManager();
    audit = new AuditLogger();
  });

  it("logs and queries by action", () => {
    const user = users.create({ username: "audited" });
    audit.log({ userId: user.id, action: "message", details: { length: 42 } });
    audit.log({ userId: user.id, action: "tool_call", details: { tool: "read" } });
    audit.log({ userId: user.id, action: "tool_call", details: { tool: "bash" } });

    const toolLogs = audit.query({ userId: user.id, action: "tool_call" });
    expect(toolLogs.length).toBe(2);

    const stats = audit.getUserStats(user.id);
    expect(stats.totalMessages).toBe(1);
    expect(stats.totalToolCalls).toBe(2);
    expect(stats.lastActive).not.toBeNull();
  });
});

describe("Week7: BackupManager", () => {
  it("creates and lists backups", async () => {
    const backupDir = path.join(TEST_DIR, "backups");
    const manager = new BackupManager(backupDir, 3);

    const info = await manager.backup();
    expect(fs.existsSync(info.path)).toBe(true);
    expect(info.size).toBeGreaterThan(0);

    const list = await manager.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses restoring from a missing file", async () => {
    const manager = new BackupManager(path.join(TEST_DIR, "backups"));
    // 目录外路径 → 拒绝（防任意文件读取）；目录内不存在 → not found
    await expect(manager.restore("/nonexistent/backup.db")).rejects.toThrow("not a backup file");
    await expect(
      manager.restore(path.join(TEST_DIR, "backups", "backup-missing.db")),
    ).rejects.toThrow("not found");
  });
});
