export interface AlertCheckResult {
  trigger: boolean;
  value: number;
  threshold: number;
}

export interface AlertRule {
  name: string;
  description: string;
  check: () => Promise<AlertCheckResult>;
  notify: (message: string) => Promise<void>;
  cooldownMs: number;
  lastTriggered?: number;
}

export interface AlertRecord {
  name: string;
  message: string;
  at: number;
}

/**
 * 监控告警系统（Week 8 Step 6）
 * 规则式检查 + 冷却窗口，避免告警风暴。
 */
export class MonitoringSystem {
  private rules: AlertRule[] = [];
  private alerts: AlertRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  addRule(rule: AlertRule): void {
    this.rules.push(rule);
  }

  start(intervalMs = 60000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.checkNow().catch((e) => console.error("monitor check error:", e));
    }, intervalMs);
    console.log(`📊 Monitoring started (${intervalMs / 1000}s interval, ${this.rules.length} rules)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 立即检查所有规则，返回本轮触发的告警数 */
  async checkNow(now = Date.now()): Promise<number> {
    let fired = 0;

    for (const rule of this.rules) {
      if (rule.lastTriggered && now - rule.lastTriggered < rule.cooldownMs) continue;
      try {
        const result = await rule.check();
        if (!result.trigger) continue;

        rule.lastTriggered = now;
        fired++;
        const message = `🚨 ${rule.name}: ${rule.description} (value=${result.value}, threshold=${result.threshold})`;
        this.alerts.push({ name: rule.name, message, at: now });
        if (this.alerts.length > 1000) this.alerts.shift();
        await rule.notify(message);
      } catch (e: any) {
        console.error(`monitor rule "${rule.name}" error: ${e.message}`);
      }
    }

    return fired;
  }

  getAlerts(limit = 50): AlertRecord[] {
    return this.alerts.slice(-limit).reverse();
  }

  /** 内置默认规则：数据库过大 + 错误率过高 */
  addDefaultRules(notify: (msg: string) => Promise<void>): void {
    this.addRule({
      name: "database-size",
      description: "数据库文件超过 500MB",
      cooldownMs: 3600000,
      check: async () => {
        const dbPath =
          process.env.EASY_AGENT_DB_PATH ??
          `${process.env.EASY_AGENT_STATE_DIR ?? `${process.env.HOME}/.local/share/easy-agent`}/agent.db`;
        const file = Bun.file(dbPath);
        const sizeMB = (await file.exists()) ? (await file.size) / 1024 / 1024 : 0;
        return { trigger: sizeMB > 500, value: Math.round(sizeMB), threshold: 500 };
      },
      notify,
    });

    this.addRule({
      name: "audit-error-rate",
      description: "最近一小时错误记录超过 20 条",
      cooldownMs: 1800000,
      check: async () => {
        const { getDatabase } = await import("../database.js");
        const row = getDatabase()
          .prepare(
            "SELECT COUNT(*) as c FROM audit_logs WHERE action = 'error' AND created_at > ?",
          )
          .get(Date.now() - 3600000) as any;
        const count = row?.c ?? 0;
        return { trigger: count > 20, value: count, threshold: 20 };
      },
      notify,
    });
  }
}
