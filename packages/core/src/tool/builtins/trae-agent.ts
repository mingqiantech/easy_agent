import { z } from "zod";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { Tool, ToolContext } from "../types.js";

/**
 * trae-cli（外部编码 agent）封装：headless 模式 `-p --json`，prompt 走 positional。
 * 声明式参数（args/resumeArgs/extraArgs 可在配置覆盖），以后接 codex/aider 同款骨架。
 * 安全：workdir 必须命中 allowedWorkdirs 前缀；yolo/permission 仅配置层可开，模型传不了。
 */
export interface TraeToolConfig {
  bin?: string; // 默认 trae-cli（PATH 查找）
  timeoutMinutes?: number; // 默认 10
  allowedWorkdirs?: string[]; // 绝对路径前缀白名单；缺省=只许 ctx.workDir
  extraArgs?: string[]; // 追加到每次调用（如 --model xxx）
  yolo?: boolean; // 配置层显式开启才传 --yolo
  permissionMode?: string; // default|plan|bypass_permissions
  allowedTools?: string[]; // 透传 --allowed-tool（白名单自动批准）
}

const MAX_OUTPUT = 50 * 1024;

/** trae -p --json 输出解析（实测 0.121.3 结构：顶层 session_id + message{role,content,response_meta.usage} + stats） */
export function parseTraeJson(stdout: string): {
  result: string;
  sessionId?: string;
  usage?: { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number };
  raw?: unknown;
  error?: string;
} {
  let j: any;
  try {
    j = JSON.parse(stdout);
  } catch {
    return { result: stdout.trim() }; // 非 JSON（text 模式/旧版）→ 原样
  }
  const error = typeof j?.error === "string" ? j.error : undefined;
  // result 字段名多版本兜底（v1: message.content；旧/他版: result/response/message 字符串）
  const msg = j?.message;
  const result =
    (typeof msg?.content === "string" && msg.content) ||
    (typeof j?.result === "string" && j.result) ||
    (typeof j?.response === "string" && j.response) ||
    (typeof msg === "string" ? msg : "") ||
    "";
  const sessionId =
    (typeof j?.session_id === "string" && j.session_id) ||
    (Array.isArray(j?.sessions) && j.sessions[0]?.session_id) ||
    undefined;
  const u = msg?.response_meta?.usage ?? j?.usage;
  const usage = u && typeof u === "object"
    ? {
        promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
        completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
        cacheReadTokens:
          typeof u.prompt_token_details?.cached_tokens === "number" ? u.prompt_token_details.cached_tokens : undefined,
      }
    : undefined;
  return { result: result || (error ? "" : JSON.stringify(j).slice(0, MAX_OUTPUT)), sessionId: sessionId || undefined, usage, raw: j, error };
}

export function createTraeTool(cfg: TraeToolConfig = {}): Tool {
  const bin = cfg.bin ?? "trae-cli";
  return {
    name: "trae_agent",
    description:
      "调用外部编码 Agent（trae-cli headless）处理代码任务：仓库分析/批量重构/写测试等重活。返回 result/sessionId（可 resume 续多轮）。工作目录受白名单限制；耗时任务给足 timeoutMinutes（默认 10 分钟）。",
    inputSchema: z.object({
      prompt: z.string().min(1).describe("交给 trae 的任务描述（会原样作为 positional 参数）"),
      workdir: z.string().optional().describe("目标仓库目录；须在 allowedWorkdirs 内，默认当前工作区"),
      resume: z.string().optional().describe("trae 会话 ID：续多轮对话"),
      timeoutMinutes: z.number().int().positive().max(60).optional(),
      allowedTools: z.array(z.string()).optional().describe("trae 侧自动批准的工具名（如 Bash,Edit）"),
    }),
    async execute(input: any, ctx: ToolContext) {
      // bin 可用性预检（配置错→清晰报错而不是 ENOENT 堆栈）
      const resolved = bin.includes("/") ? bin : null;
      if (resolved && !fs.existsSync(resolved)) {
        return { error: `trae-cli 不存在: ${resolved}（配置 trae.bin 或 PATH）` };
      }
      // 工作目录围栏
      const wd = input.workdir ? path.resolve(ctx.workDir, input.workdir) : ctx.workDir;
      const allow = (cfg.allowedWorkdirs?.length ? cfg.allowedWorkdirs : [ctx.workDir])
        .map((d) => path.resolve(d));
      if (!allow.some((d) => wd === d || wd.startsWith(d + path.sep))) {
        return { error: `workdir 不在允许列表: ${wd}（配置 trae.allowedWorkdirs 放开）` };
      }
      const timeoutMs = (input.timeoutMinutes ?? cfg.timeoutMinutes ?? 10) * 60_000;
      // 声明式参数组装：print+json 基座 + resume + 工具白名单 + 权限策略
      // ⚠️ 不用 -w：它是 --worktree（git worktree 隔离），非工作目录；目录靠 spawn cwd
      const baseArgs = ["-p", "--json"];
      const permArgs = [
        ...(cfg.yolo ? ["--yolo"] : []),
        ...(cfg.permissionMode ? ["--permission-mode", cfg.permissionMode] : []),
        ...((input.allowedTools ?? cfg.allowedTools ?? []).flatMap((t) => ["--allowed-tool", t])),
      ];
      const args = [
        ...baseArgs,
        ...permArgs,
        ...(cfg.extraArgs ?? []),
        ...(input.resume ? ["--resume", input.resume] : []),
        input.prompt,
      ];
      return new Promise((resolve) => {
        const child = spawn(bin, args, {
          cwd: wd,
          env: { ...process.env, TERM: "dumb" },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // 独立进程组：kill 整棵树（trae 会再生 bash 子进程，只杀父会卡住管道）
        });
        const killGroup = (sig: NodeJS.Signals) => {
          try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch {} }
        };
        let stdout = "", stderr = "", truncated = false;
        const kill = (why: string) => {
          killedBy = killedBy ?? why;
          killGroup("SIGTERM");
          setTimeout(() => killGroup("SIGKILL"), 3000).unref();
        };
        let killedBy: string | null = null;
        const timer = setTimeout(() => kill("timeout"), timeoutMs);
        const onAbort = () => kill("aborted");
        if (ctx.abortSignal) {
          if (ctx.abortSignal.aborted) onAbort();
          else ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdout.on("data", (d) => {
          if (stdout.length < MAX_OUTPUT) stdout += d.toString();
          else truncated = true;
        });
        child.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d.toString(); });
        child.on("close", (code) => {
          clearTimeout(timer);
          ctx.abortSignal?.removeEventListener?.("abort", onAbort);
          if (killedBy === "aborted") return resolve({ aborted: true, note: "用户中断，trae 任务已终止" });
          if (killedBy === "timeout")
            return resolve({ error: `trae 超时（${timeoutMs / 60000} 分钟）；可拆小任务或加大 timeoutMinutes`, partial: parseTraeJson(stdout).result?.slice(0, 500) });
          const parsed = parseTraeJson(stdout);
          if (parsed.error) return resolve({ error: `trae: ${parsed.error}`, ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}) });
          resolve({
            exitCode: code,
            result: parsed.result || (stderr ? `[stderr] ${stderr.slice(0, 400)}` : "(空输出)"),
            ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
            ...(parsed.usage?.promptTokens || parsed.usage?.completionTokens ? { usage: parsed.usage } : {}),
            ...(truncated ? { truncated: true } : {}),
          });
        });
        child.on("error", (e: any) => {
          clearTimeout(timer);
          resolve({ error: `trae-cli 启动失败: ${e.message}（确认已安装并在 PATH，或配置 trae.bin 绝对路径；注意 trae-cli 需先完成登录/模型配置）` });
        });
      });
    },
  };
}
