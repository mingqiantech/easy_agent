import { getDatabase } from "../database.js";
import { ulid } from "ulid";

export type ScheduleKind = "at" | "every" | "cron";

export interface CronJobConfig {
  name: string;
  description?: string;
  schedule: {
    kind: ScheduleKind;
    at?: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
  };

  payload: {
    kind: "agentTurn" | "script";
    message?: string;
    script?: string;
  };

  sessionTarget: "main" | "isolated";
  enable: boolean;
}

export class CronManager {
  create(job: CronJobConfig): string {
    const db = getDatabase();
    const id = ulid();
    const now = Date.now();
    const nextRun = this.calcNextRun(job.schedule);
    db.prepare(
      `
      INSERT INTO cron_jobs (id, name, description, schedule_kind, schedule_config,
        payload_kind, payload_config, enabled, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      job.name,
      job.description ?? null,
      job.schedule.kind,
      JSON.stringify(job.schedule),
      job.payload.kind,
      JSON.stringify(job.payload),
      job.enable ? 1 : 0,
      nextRun,
      now,
      now,
    );
    return id;
  }

  list(): any[] {
    const db = getDatabase();
    return db
      .prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC")
      .all()
      .map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        scheduler: JSON.parse(r.schedule_config),
        payload: JSON.parse(r.payload_config),
        enabled: !!r.enabled,
        lastRunAt: r.last_run_at,
        nextRunAt: r.next_run_at,
        runCount: r.run_count,
      }));
  }

  delete(id: string): void {
    getDatabase().prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  getDueJobs(): any[] {
    const db = getDatabase();
    return db
      .prepare(
        `
      SELECT * FROM cron_jobs WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at ASC
    `,
      )
      .all(Date.now())
      .map((r: any) => ({
        id: r.id,
        name: r.name,
        payload: JSON.parse(r.payload_config),
        scheduler: JSON.parse(r.schedule_config),
      }));
  }

  markRun(id: string, success: boolean): void {
    const db = getDatabase();
    const now = Date.now();
    db.prepare(
      "UPDATE cron_jobs SET last_run_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?",
    ).run(now, now, id);
    db.prepare(
      "INSERT INTO cron_runs (job_id, status, started_at, completed_at) VALUES (?, ?, ?, ?)",
    ).run(id, success ? "success" : "failure", now, now);
  }

  /** 注册 Dreaming 定时任务 */
  registerDreamingJobs(): void {
    const existing = this.list();
    if (existing.some((j) => j.name === "light-dreaming")) return;

    this.create({
      name: "light-dreaming",
      description: "轻度记忆巩固（每 4 小时）",
      schedule: { kind: "every", everyMs: 4 * 3600 * 1000 },
      payload: {
        kind: "agentTurn",
        message: "执行轻度记忆巩固：扫描最近会话，提取关键信息到短期记忆。",
      },
      sessionTarget: "isolated",
      enabled: true,
    });

    this.create({
      name: "rem-dreaming",
      description: "REM 记忆评估（每 12 小时）",
      schedule: { kind: "every", everyMs: 12 * 3600 * 1000 },
      payload: {
        kind: "agentTurn",
        message: "执行 REM 记忆评估：对短期记忆条目评分，标记提升候选。",
      },
      sessionTarget: "isolated",
      enabled: true,
    });

    this.create({
      name: "deep-dreaming",
      description: "深度记忆巩固（每天凌晨 3 点）",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      payload: {
        kind: "agentTurn",
        message: "执行深度记忆巩固：提升候选到 MEMORY.md，清理过期条目。",
      },
      sessionTarget: "isolated",
      enabled: true,
    });
  }

  private calcNextRun(schedule: CronJobConfig["schedule"]): number {
    const now = Date.now();
    switch (schedule.kind) {
      case "at":
        return schedule.at ? new Date(schedule.at).getTime() : now;
      case "every":
        return now + (schedule.everyMs ?? 3600000);
      case "cron":
        return now + 3600000;
      default:
        return now + 3600000;
    }
  }
}
