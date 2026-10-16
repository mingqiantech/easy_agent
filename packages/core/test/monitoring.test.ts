import { describe, it, expect } from "bun:test";
import { MonitoringSystem } from "../src/monitoring/index.js";

describe("MonitoringSystem", () => {
  it("fires alert when rule triggers", async () => {
    const mon = new MonitoringSystem();
    const notifications: string[] = [];

    mon.addRule({
      name: "test-rule",
      description: "always breaks",
      cooldownMs: 60000,
      check: async () => ({ trigger: true, value: 42, threshold: 10 }),
      notify: async (msg) => {
        notifications.push(msg);
      },
    });

    const fired = await mon.checkNow();
    expect(fired).toBe(1);
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("test-rule");
    expect(mon.getAlerts()[0].name).toBe("test-rule");
  });

  it("does not fire when below threshold", async () => {
    const mon = new MonitoringSystem();
    mon.addRule({
      name: "quiet",
      description: "ok",
      cooldownMs: 1000,
      check: async () => ({ trigger: false, value: 1, threshold: 10 }),
      notify: async () => {},
    });

    expect(await mon.checkNow()).toBe(0);
    expect(mon.getAlerts().length).toBe(0);
  });

  it("respects cooldown between fires", async () => {
    const mon = new MonitoringSystem();
    let notifyCount = 0;
    mon.addRule({
      name: "flappy",
      description: "spams",
      cooldownMs: 10000,
      check: async () => ({ trigger: true, value: 99, threshold: 1 }),
      notify: async () => {
        notifyCount++;
      },
    });

    const t0 = 1000000;
    expect(await mon.checkNow(t0)).toBe(1);
    expect(await mon.checkNow(t0 + 5000)).toBe(0); // 冷却中
    expect(await mon.checkNow(t0 + 15000)).toBe(1); // 冷却结束
    expect(notifyCount).toBe(2);
  });

  it("one broken rule does not block the rest", async () => {
    const mon = new MonitoringSystem();
    let secondFired = false;

    mon.addRule({
      name: "broken",
      description: "throws",
      cooldownMs: 1000,
      check: async () => {
        throw new Error("check exploded");
      },
      notify: async () => {},
    });
    mon.addRule({
      name: "healthy-rule",
      description: "ok",
      cooldownMs: 1000,
      check: async () => ({ trigger: true, value: 5, threshold: 1 }),
      notify: async () => {
        secondFired = true;
      },
    });

    await mon.checkNow();
    expect(secondFired).toBe(true);
  });

  it("keeps alert history bounded", async () => {
    const mon = new MonitoringSystem();
    mon.addRule({
      name: "spam",
      description: "x",
      cooldownMs: 0,
      check: async () => ({ trigger: true, value: 1, threshold: 0 }),
      notify: async () => {},
    });

    for (let i = 0; i < 5; i++) await mon.checkNow(1000 + i);
    expect(mon.getAlerts().length).toBe(5);
    expect(mon.getAlerts(2).length).toBe(2);
  });
});
