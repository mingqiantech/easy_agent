import { describe, it, expect } from "bun:test";
import { Workflow } from "../src/workflow/index.js";

describe("Workflow engine", () => {
  it("runs steps in order and collects results", async () => {
    const order: string[] = [];
    const wf = new Workflow("basic")
      .step("first", async () => {
        order.push("first");
        return 1;
      })
      .step("second", async (ctx) => {
        order.push("second");
        return (ctx.results["first"] as number) + 1;
      });

    const result = await wf.run();

    expect(result.status).toBe("completed");
    expect(order).toEqual(["first", "second"]);
    expect(result.results["second"]).toBe(2);
    expect(result.steps.length).toBe(2);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("skips steps when condition is false", async () => {
    let ran = false;
    const wf = new Workflow("conditional").step("maybe", async () => {
      ran = true;
      return "x";
    }, { condition: (ctx) => ctx.data.enable === true });

    const result = await wf.run({ enable: false });

    expect(ran).toBe(false);
    expect(result.steps[0].status).toBe("skipped");
  });

  it("skips dependents when a step fails", async () => {
    const wf = new Workflow("failing")
      .step("boom", async () => {
        throw new Error("boom failed");
      })
      .step("after", async () => "never", { dependsOn: ["boom"] });

    const result = await wf.run();

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].error).toContain("boom failed");
    expect(result.steps[1].status).toBe("skipped");
  });

  it("retries failing steps up to configured count", async () => {
    let attempts = 0;
    const wf = new Workflow("retrying").step(
      "flaky",
      async () => {
        attempts++;
        if (attempts < 3) throw new Error(`attempt ${attempts} failed`);
        return "ok";
      },
      { retries: 2 },
    );

    const result = await wf.run();

    expect(attempts).toBe(3);
    expect(result.status).toBe("completed");
    expect(result.steps[0].status).toBe("completed");
  });

  it("reports partial when some steps complete and others fail", async () => {
    const wf = new Workflow("partial")
      .step("good", async () => "done")
      .step("bad", async () => {
        throw new Error("nope");
      });

    const result = await wf.run();

    expect(result.status).toBe("partial");
    expect(result.steps[0].status).toBe("completed");
    expect(result.steps[1].status).toBe("failed");
  });

  it("rejects duplicate step names", () => {
    const wf = new Workflow("dup").step("a", async () => 1);
    expect(() => wf.step("a", async () => 2)).toThrow("Duplicate step name");
  });

  it("passes initial data into context", async () => {
    const wf = new Workflow("data").step("read", async (ctx) => ctx.data.value);
    const result = await wf.run({ value: 42 });
    expect(result.results["read"]).toBe(42);
  });
});
