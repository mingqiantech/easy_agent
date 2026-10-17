import { getDatabase } from "../database.js";
import { generateId, now } from "../utils.js";

export interface Team {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  ownerId: string;
  createdAt: number;
}

export type TeamRole = "owner" | "admin" | "member" | "viewer";

export interface TeamMember {
  userId: string;
  teamId: string;
  role: TeamRole;
  joinedAt: number;
}

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

function rowToTeam(row: any): Team {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
}

/**
 * 团队管理器（Week 9）
 * 团队、成员角色层级、共享工作区与共享记忆。
 */
export class TeamManager {
  create(name: string, ownerId: string, displayName?: string): Team {
    const db = getDatabase();
    const id = generateId();
    const ts = now();

    db.prepare(
      `INSERT INTO teams (id, name, display_name, description, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    ).run(id, name, displayName ?? null, ownerId, ts, ts);

    // 创建者自动成为 owner
    db.prepare(
      `INSERT INTO team_members (id, team_id, user_id, role, joined_at)
       VALUES (?, ?, ?, 'owner', ?)`,
    ).run(generateId(), id, ownerId, ts);

    return this.get(id)!;
  }

  get(id: string): Team | null {
    const row = getDatabase().prepare("SELECT * FROM teams WHERE id = ?").get(id) as any;
    return row ? rowToTeam(row) : null;
  }

  listForUser(userId: string): Team[] {
    return getDatabase()
      .prepare(
        `SELECT t.* FROM teams t
         JOIN team_members m ON m.team_id = t.id
         WHERE m.user_id = ? ORDER BY t.created_at DESC`,
      )
      .all(userId)
      .map((r: any) => rowToTeam(r));
  }

  addMember(teamId: string, userId: string, role: TeamRole = "member"): void {
    getDatabase()
      .prepare(
        `INSERT INTO team_members (id, team_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(generateId(), teamId, userId, role, now());
  }

  removeMember(teamId: string, userId: string): { ok: boolean; reason?: string } {
    const team = this.get(teamId);
    if (!team) return { ok: false, reason: "team not found" };
    if (team.ownerId === userId) return { ok: false, reason: "cannot remove owner" };

    getDatabase()
      .prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .run(teamId, userId);
    return { ok: true };
  }

  listMembers(teamId: string): TeamMember[] {
    return getDatabase()
      .prepare(
        `SELECT user_id as userId, team_id as teamId, role, joined_at as joinedAt
         FROM team_members WHERE team_id = ? ORDER BY joined_at`,
      )
      .all(teamId) as TeamMember[];
  }

  getRole(teamId: string, userId: string): TeamRole | null {
    const row = getDatabase()
      .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
      .get(teamId, userId) as any;
    return (row?.role as TeamRole) ?? null;
  }

  /** 角色层级：owner > admin > member > viewer */
  hasPermission(teamId: string, userId: string, minRole: TeamRole): boolean {
    const role = this.getRole(teamId, userId);
    if (!role) return false;
    return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minRole];
  }

  // ---- 工作区 ----

  createWorkspace(teamId: string, name: string, workDir: string): string {
    const id = generateId();
    getDatabase()
      .prepare(
        `INSERT INTO team_workspaces (id, team_id, name, work_dir, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, teamId, name, workDir, now());
    return id;
  }

  listWorkspaces(teamId: string): Array<{ id: string; name: string; workDir: string }> {
    return getDatabase()
      .prepare(
        "SELECT id, name, work_dir as workDir FROM team_workspaces WHERE team_id = ?",
      )
      .all(teamId) as any[];
  }

  getSharedMemory(workspaceId: string): string {
    const row = getDatabase()
      .prepare("SELECT shared_memory FROM team_workspaces WHERE id = ?")
      .get(workspaceId) as any;
    if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
    return row.shared_memory ?? "";
  }

  updateSharedMemory(workspaceId: string, content: string): void {
    const r = getDatabase()
      .prepare("UPDATE team_workspaces SET shared_memory = ? WHERE id = ?")
      .run(content, workspaceId);
    if (r.changes === 0) throw new Error(`Workspace not found: ${workspaceId}`);
  }

  appendSharedMemory(workspaceId: string, line: string): void {
    const current = this.getSharedMemory(workspaceId);
    const next = current ? `${current}\n${line}` : line;
    this.updateSharedMemory(workspaceId, next);
  }
}
