import { getDatabase } from "../database.js";
import { ulid } from "ulid";
import { execSync } from "node:child_process";

export type ScheduleKind = "at" | "every" | "cron" | "watch";

export interface CronJobConfig {
  name: string;
  description?: string;
  schedule: {
    kind: ScheduleKind;
    at?: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
    /** watch：静默检查命令，输出 JSON {fire,message?}，命中才执行 payload */
    command?: string;
    timeoutMs?: number;
  };

  payload: {
    kind: "agentTurn" | "script";
    message?: string;
    script?: string;
  };

  sessionTarget: "main" | "isolated";
  enabled: boolean;
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
      job.enabled ? 1 : 0,
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
        schedule: JSON.parse(r.schedule_config),
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
        schedule: JSON.parse(r.schedule_config),
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

  /**
   * 事件 watcher 静默检查（零 LLM 成本）：跑命令、解析 stdout JSON。
   * 输出 {fire:true,message?} 才算命中；出错/无输出/非 JSON 一律不触发。
   */
  runWatchCheck(schedule: {
    command?: string;
    timeoutMs?: number;
  }): { fire: boolean; message?: string } | null {
    if (!schedule.command) return null;
    try {
      const out = execSync(schedule.command, {
        timeout: schedule.timeoutMs ?? 30000,
        maxBuffer: 64 * 1024,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (!out) return null;
      const brace = out.indexOf("{");
      if (brace === -1) return null;
      const parsed = JSON.parse(out.slice(brace));
      return parsed && typeof parsed.fire === "boolean" ? parsed : null;
    } catch (e: any) {
      console.warn(
        `watch 检查失败: ${String(e?.message ?? e).slice(0, 120)}`,
      );
      return null;
    }
  }

  /** 运行后推进 next_run_at（every/watch 按间隔）；at 一次性任务自动禁用 */
  advanceNext(
    id: string,
    schedule: CronJobConfig["schedule"],
  ): void {
    const db = getDatabase();
    if (schedule.kind === "at") {
      db
        .prepare(
          "UPDATE cron_jobs SET enabled = 0, next_run_at = NULL WHERE id = ?",
        )
        .run(id);
      return;
    }
    const ms =
      schedule.kind === "watch"
        ? (schedule.everyMs ?? 300000)
        : (schedule.everyMs ?? 3600000);
    db
      .prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?")
      .run(Date.now() + ms, id);
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
      case "watch":
        return now + (schedule.everyMs ?? 300000);
      default:
        return now + 3600000;
    }
  }
}
