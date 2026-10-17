import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 隔离状态目录
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "easy-agent-w9-test-"));
process.env.EASY_AGENT_STATE_DIR = path.join(TEST_DIR, "state");
process.env.EASY_AGENT_DB_PATH = path.join(TEST_DIR, "state", "agent.db");

import { getDatabase } from "../src/database.js";
import { UserManager } from "../src/user/manager.js";
import { TeamManager } from "../src/team/manager.js";
import { NotificationManager } from "../src/notifications/index.js";
import { gitTool } from "../src/tool/builtins/git.js";

beforeAll(() => {
  getDatabase(process.env.EASY_AGENT_DB_PATH!);
});

describe("Week9: TeamManager", () => {
  let teams: TeamManager;
  let users: UserManager;
  let ownerId: string;
  let memberId: string;
  let viewerId: string;

  beforeAll(() => {
    teams = new TeamManager();
    users = new UserManager();
    ownerId = users.create({ username: "w9-owner" }).id;
    memberId = users.create({ username: "w9-member" }).id;
    viewerId = users.create({ username: "w9-viewer" }).id;
  });

  it("creates a team with owner membership", () => {
    const team = teams.create("devs", ownerId, "开发组");
    expect(team.name).toBe("devs");

    const members = teams.listMembers(team.id);
    expect(members.length).toBe(1);
    expect(members[0].role).toBe("owner");
  });

  it("manages members with role hierarchy", () => {
    const team = teams.create("roles-test", ownerId);
    teams.addMember(team.id, memberId, "member");
    teams.addMember(team.id, viewerId, "viewer");

    expect(teams.hasPermission(team.id, memberId, "viewer")).toBe(true);
    expect(teams.hasPermission(team.id, viewerId, "member")).toBe(false);
    expect(teams.hasPermission(team.id, ownerId, "admin")).toBe(true);

    // 非成员无权限
    const outsider = users.create({ username: "w9-outsider" }).id;
    expect(teams.hasPermission(team.id, outsider, "viewer")).toBe(false);
  });

  it("refuses removing the owner", () => {
    const team = teams.create("keep-owner", ownerId);
    const result = teams.removeMember(team.id, ownerId);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("owner");
  });

  it("lists teams per user", () => {
    const team = teams.create("shared-team", ownerId);
    teams.addMember(team.id, memberId, "member");
    const list = teams.listForUser(memberId);
    expect(list.find((t) => t.id === team.id)).toBeDefined();
  });

  it("workspaces hold shared memory", () => {
    const team = teams.create("ws-team", ownerId);
    const wsId = teams.createWorkspace(team.id, "main", "/tmp/ws");

    teams.appendSharedMemory(wsId, "- decision: use bun");
    teams.appendSharedMemory(wsId, "- pref: dark theme");
    const mem = teams.getSharedMemory(wsId);
    expect(mem).toContain("use bun");
    expect(mem.split("\n").length).toBe(2);

    expect(() => teams.getSharedMemory("nonexistent")).toThrow("not found");
  });
});

describe("Week9: NotificationManager", () => {
  let notifications: NotificationManager;
  let userId: string;

  beforeAll(() => {
    notifications = new NotificationManager();
    userId = new UserManager().create({ username: "w9-notify-user" }).id;
  });

  it("stores and lists notifications", async () => {
    await notifications.notify(userId, "PR Reviewed", "2 findings on #42", { level: "warning" });
    await notifications.notify(userId, "Backup done", "136KB", { level: "info" });

    const list = notifications.list(userId);
    expect(list.length).toBe(2);
    expect(list[0].level).toBe("warning"); // 最新在前
    expect(notifications.unreadCount(userId)).toBe(2);
  });

  it("marks read and counts correctly", async () => {
    const n = await notifications.notify(userId, "t", "b");
    notifications.markRead(n.id);
    const unread = notifications.list(userId, true);
    expect(unread.find((x) => x.id === n.id)).toBeUndefined();

    const changed = notifications.markAllRead(userId);
    expect(changed).toBeGreaterThanOrEqual(0);
    expect(notifications.unreadCount(userId)).toBe(0);
  });
});

describe("Week9: git tool", () => {
  const repo = path.join(TEST_DIR, "git-repo");
  const ctx = { sessionId: "t", agentId: "t", workDir: repo };

  beforeAll(() => {
    const { spawnSync } = require("node:child_process");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello");

    const git = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
      if (r.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      }
      return r.stdout;
    };

    git(["init", "-b", "main"]);
    git(["add", "a.txt"]);
    git(["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
  });

  it("runs git status in repo", async () => {
    const result = (await gitTool.execute({ action: "status" }, ctx)) as any;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("main");
  });

  it("runs git log", async () => {
    const result = (await gitTool.execute({ action: "log" }, ctx)) as any;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("init");
  });

  it("blocks dangerous operations", async () => {
    const result = (await gitTool.execute(
      { action: "push", args: ["--force", "origin", "main"] },
      ctx,
    )) as any;
    expect(result.error).toContain("Blocked");
  });

  it("requires message for commit", async () => {
    const result = (await gitTool.execute({ action: "commit" }, ctx)) as any;
    expect(result.error).toContain("message");
  });
});
