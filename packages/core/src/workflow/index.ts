import { generateId, now } from "../utils.js";

export type StepStatus = "completed" | "failed" | "skipped";

export interface WorkflowStepConfig {
  /** 条件：返回 false 则跳过该步骤 */
  condition?: (ctx: WorkflowContext) => boolean;
  /** 依赖的前置步骤名（任一 failed 则本步 skipped） */
  dependsOn?: string[];
  /** 失败重试次数（默认 0） */
  retries?: number;
}

export interface WorkflowContext {
  workflowId: string;
  name: string;
  data: Record<string, unknown>;
  results: Record<string, unknown>;
  currentStep: string;
  log: (message: string) => void;
}

export interface WorkflowStepResult {
  name: string;
  status: StepStatus;
  durationMs: number;
  error?: string;
}

export interface WorkflowRunResult {
  id: string;
  name: string;
  status: "completed" | "failed" | "partial";
  results: Record<string, unknown>;
  steps: WorkflowStepResult[];
  totalDurationMs: number;
}

/**
 * 工作流引擎（Week 8）
 *
 * 多步骤任务编排：顺序执行、条件跳过、依赖失败传播、失败重试。
 *
 *   const wf = new Workflow("deploy")
 *     .step("build", async (ctx) => runBuild())
 *     .step("test", async (ctx) => runTests(), { dependsOn: ["build"] })
 *     .step("notify", async (ctx) => send(ctx.results["test"]), {
 *         condition: (ctx) => ctx.data.skipNotify !== true,
 *     });
 *   const result = await wf.run({ skipNotify: false });
 */
export class Workflow {
  private steps: Array<{
    name: string;
    execute: (ctx: WorkflowContext) => Promise<unknown>;
    config: WorkflowStepConfig;
  }> = [];
  private id: string;

  constructor(private name: string) {
    this.id = generateId();
  }

  step(
    name: string,
    execute: (ctx: WorkflowContext) => Promise<unknown>,
    config: WorkflowStepConfig = {},
  ): this {
    if (this.steps.some((s) => s.name === name)) {
      throw new Error(`Duplicate step name: ${name}`);
    }
    this.steps.push({ name, execute, config });
    return this;
  }

  async run(initialData: Record<string, unknown> = {}): Promise<WorkflowRunResult> {
    const startTime = now();
    const ctx: WorkflowContext = {
      workflowId: this.id,
      name: this.name,
      data: { ...initialData },
      results: {},
      currentStep: "",
      log: (message) => console.log(`  [wf:${this.name}] ${message}`),
    };

    const stepResults: WorkflowStepResult[] = [];
    let hasFailed = false;

    for (const step of this.steps) {
      ctx.currentStep = step.name;
      const stepStart = now();

      // 条件跳过
      if (step.config.condition && !step.config.condition(ctx)) {
        stepResults.push({ name: step.name, status: "skipped", durationMs: 0 });
        ctx.log(`Step "${step.name}" skipped (condition false)`);
        continue;
      }

      // 依赖失败传播
      const failedDep = step.config.dependsOn?.find(
        (dep) =>
          !stepResults.some((s) => s.name === dep && s.status === "completed"),
      );
      if (failedDep) {
        stepResults.push({
          name: step.name,
          status: "skipped",
          durationMs: 0,
          error: `Dependency "${failedDep}" not completed`,
        });
        ctx.log(`Step "${step.name}" skipped (dependency "${failedDep}")`);
        continue;
      }

      // 前序失败则停止（partial），除非显式声明不依赖
      if (hasFailed && step.config.dependsOn) {
        stepResults.push({
          name: step.name,
          status: "skipped",
          durationMs: 0,
          error: "Previous step failed",
        });
        continue;
      }

      // 执行 + 重试
      const maxAttempts = (step.config.retries ?? 0) + 1;
      let lastError: string | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          ctx.log(`Step "${step.name}" executing (attempt ${attempt}/${maxAttempts})`);
          const result = await step.execute(ctx);
          ctx.results[step.name] = result;
          stepResults.push({
            name: step.name,
            status: "completed",
            durationMs: now() - stepStart,
          });
          lastError = undefined;
          break;
        } catch (e: any) {
          lastError = e?.message ?? String(e);
          ctx.log(`Step "${step.name}" failed (attempt ${attempt}): ${lastError}`);
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 100 * attempt));
          }
        }
      }

      if (lastError) {
        stepResults.push({
          name: step.name,
          status: "failed",
          durationMs: now() - stepStart,
          error: lastError,
        });
        hasFailed = true;
      }
    }

    const completedCount = stepResults.filter((s) => s.status === "completed").length;
    const status: WorkflowRunResult["status"] = hasFailed
      ? completedCount > 0
        ? "partial"
        : "failed"
      : "completed";

    return {
      id: this.id,
      name: this.name,
      status,
      results: ctx.results,
      steps: stepResults,
      totalDurationMs: now() - startTime,
    };
  }
}
