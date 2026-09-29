import type { CronManager } from "./index.js";

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private cron: CronManager,
    private executor: (job: any) => Promise<void>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60000);
    console.log("⏰ Cron scheduler started (checking every 60s)");
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const jobs = this.cron.getDueJobs();
    for (const job of jobs) {
      try {
        await this.executor(job);
        this.cron.markRun(job.id, true);
      } catch (e: any) {
        console.error(`Cron job "${job.name}" failed: ${e.message}`);
        this.cron.markRun(job.id, false);
      }
    }
  }
}
