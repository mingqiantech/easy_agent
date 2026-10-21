import { z } from "zod";
import path from "node:path";
import { AcpConnection } from "../../acp/client.js";
import type { Tool, ToolContext } from "../types.js";

/**
 * acp_agent：把外部编码 agent（trae-cli 等）当**长驻 ACP 会话**用。
 * 与 trae_agent（headless 一次一发）互补：进程池复用，多轮上下文留在 agent 侧，
 * 拿得到 tool_call 活动流；权限审批按配置策略自动应答（工具场景无法交互弹卡）。
 */
export interface AcpAgentConfig {
  /** 逻辑名 -> 启动命令；工具参数 agent 选择，缺省第一个 */
  agents: Record<string, { bin: string; args?: string[]; cwd?: string }>;
  timeoutMinutes?: number;      // 单次 prompt 上限，默认 15（ACP 回合比 headless 快）
  idleMinutes?: number;         // 空闲多久回收进程，默认 10
  autoApprove?: boolean;        // 权限请求选 allow_*（缺省 true；false→reject_once）
  allowedWorkdirs?: string[];   // workdir 前缀围栏；缺省=ctx.workDir
  maxSessionsPerAgent?: number; // 每个 agent 池内会话数上限（LRU 回收），默认 4
}

interface PoolEntry {
  conn: AcpConnection;
  agent: string;
  cwd: string;
  sessionId: string;
  lastUsed: number;
  busy: boolean;
}

const MAX_TEXT = 16 * 1024;

/** 权限应答：按 ACP outcome option kind 择优 */
export function pickPermissionOption(options: any[], autoApprove: boolean): string | undefined {
  const want = autoApprove ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of want) {
    const hit = options.find((o: any) => o?.kind === kind);
    if (hit?.optionId) return hit.optionId;
  }
  // kind 缺失时按名字模糊
  const fuzzy = options.find((o: any) => (autoApprove ? /allow/i : /reject|deny/i).test(String(o?.name ?? o?.optionId ?? "")));
  return fuzzy?.optionId ?? options[0]?.optionId;
}

export function createAcpAgentTool(cfg: AcpAgentConfig): Tool {
  const pool = new Map<string, PoolEntry>(); // key: agent|cwd|session槽位
  const spawnAgent = (name: string) => {
    const a = cfg.agents[name];
    if (!a) throw new Error(`未知 ACP agent "${name}"（可用: ${Object.keys(cfg.agents).join(", ")}）`);
    return a;
  };

  const reapIdle = () => {
    const idleMs = (cfg.idleMinutes ?? 10) * 60_000;
    for (const [k, e] of pool) {
      if (!e.busy && Date.now() - e.lastUsed > idleMs) { e.conn.close(); pool.delete(k); }
    }
  };

  const getEntry = async (agent: string, cwd: string, resume?: string): Promise<PoolEntry> => {
    // 复用：同 agent+cwd 的空闲会话
    if (!resume) {
      for (const e of pool.values()) {
        if (!e.busy && e.agent === agent && e.cwd === cwd && e.conn.alive) { e.busy = true; e.lastUsed = Date.now(); return e; }
      }
    }
    const a = spawnAgent(agent);
    const conn = new AcpConnection({
      bin: a.bin,
      args: a.args ?? ["acp", "serve"],
      cwd,
      label: `acp:${agent}`,
      onServerRequest: async (method, params) => {
        if (method === "session/request_permission") {
          const optionId = pickPermissionOption(params?.options ?? [], cfg.autoApprove !== false);
          return { outcome: { outcome: "selected", optionId } };
        }
        return {}; // 其余 server→client 请求回空对象（readTextFile 等能力未声明，正常不会来）
      },
    });
    try {
      await conn.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
      const ns: any = await conn.request("session/new", { cwd, mcpServers: [] }, 30_000);
      const sessionId = resume || ns?.sessionId;
      if (!sessionId) throw new Error("session/new 未返回 sessionId");
      if (resume) {
        // loadSession 能力：显式恢复历史会话；失败则视 resume 为新会话提示
        try { await conn.request("session/load", { sessionId, cwd, mcpServers: [] }, 30_000); }
        catch (e: any) { conn.close(); throw new Error(`恢复会话 ${resume} 失败: ${e.message}（会话属另一进程时请沿用返回的 sessionId 连续对话）`); }
      }
      const entry: PoolEntry = { conn, agent, cwd, sessionId, lastUsed: Date.now(), busy: true };
      reapIdle();
      // 池上限：LRU 驱逐该 agent 最久未用且非 busy 的会话
      const sameAgent = [...pool.entries()].filter(([, e]) => e.agent === agent);
      const max = cfg.maxSessionsPerAgent ?? 4;
      if (sameAgent.length >= max) {
        sameAgent.sort((x, y) => x[1].lastUsed - y[1].lastUsed);
        const [evKey, ev] = sameAgent[0];
        if (!ev.busy) { ev.conn.close(); pool.delete(evKey); }
      }
      pool.set(`${agent}|${cwd}|${sessionId}`, entry);
      return entry;
    } catch (e) {
      conn.close();
      throw e;
    }
  };

  return {
    name: "acp_agent",
    description:
      "通过 ACP 协议调用外部编码 Agent 长会话（比 trae_agent 快：进程常驻、多轮上下文在 Agent 侧）。参数 prompt 必填；返回 {result, sessionId, toolActivity}——续对话传 resume=上次 sessionId 或直接同 workdir 复用。适用：连续多步代码任务。",
    inputSchema: z.object({
      prompt: z.string().min(1),
      agent: z.string().optional().describe(`ACP agent 逻辑名，缺省 ${Object.keys(cfg.agents)[0] ?? "trae"}`),
      workdir: z.string().optional(),
      resume: z.string().optional().describe("恢复指定 ACP 会话 ID"),
      timeoutMinutes: z.number().int().positive().max(60).optional(),
    }),
    async execute(input: any, ctx: ToolContext) {
      const agent = input.agent ?? Object.keys(cfg.agents)[0];
      if (!agent || !cfg.agents[agent]) {
        return { error: `未知 agent "${agent}"，可选: ${Object.keys(cfg.agents).join(", ")}` };
      }
      const wd = input.workdir ? path.resolve(ctx.workDir, input.workdir) : ctx.workDir;
      const allow = (cfg.allowedWorkdirs?.length ? cfg.allowedWorkdirs : [ctx.workDir]).map((d) => path.resolve(d));
      if (!allow.some((d) => wd === d || wd.startsWith(d + path.sep))) {
        return { error: `workdir 不在允许列表: ${wd}（配置 acp.allowedWorkdirs 放开）` };
      }
      const timeoutMs = (input.timeoutMinutes ?? cfg.timeoutMinutes ?? 15) * 60_000;

      let entry: PoolEntry;
      try { entry = await getEntry(agent, wd, input.resume); }
      catch (e: any) { return { error: `ACP 会话建立失败: ${e.message}` }; }

      // 收集回合事件
      let message = "", thoughtLen = 0;
      const tools: string[] = [];
      let messageTruncated = false;
      const onNote = (method: string, params: any) => {
        if (method !== "session/update" || params?.sessionId !== entry.sessionId) return;
        const u = params.update ?? {};
        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const t = String(u.content?.text ?? "");
            if (message.length < MAX_TEXT) message += t; else messageTruncated = true;
            break;
          }
          case "agent_thought_chunk": thoughtLen += String(u.content?.text ?? "").length; break;
          case "tool_call": tools.push(String(u.title ?? u.kind ?? "tool")); break;
        }
      };
      // 挂接本轮通知收集
      entry.conn.setNotificationHandler(onNote);

      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

      try {
        const res: any = await Promise.race([
          entry.conn.request("session/prompt", {
            sessionId: entry.sessionId,
            prompt: [{ type: "text", text: input.prompt }],
          }, timeoutMs),
          new Promise((_, rej) => { ctrl.signal.addEventListener("abort", () => rej(new Error("__aborted__"))); }),
        ]);
        return {
          result: message || "(无文本输出)",
          ...(thoughtLen ? { thoughtChars: thoughtLen } : {}),
          ...(tools.length ? { toolActivity: tools.slice(0, 20) } : {}),
          stopReason: res?.stopReason ?? "unknown",
          sessionId: entry.sessionId,
          ...(messageTruncated ? { truncated: true } : {}),
        };
      } catch (e: any) {
        if (String(e?.message) === "__aborted__") {
          entry.conn.close(); // 中断语义不明（trae 是否吃 cancel 未验）→ 直接回收进程最稳
          return { aborted: true, note: "用户中断；该 ACP 会话进程已回收" };
        }
          if (!entry.conn.alive) entry.conn.close();
        return { error: `ACP prompt 失败: ${e.message}` };
      } finally {
        ctx.abortSignal?.removeEventListener?.("abort", onAbort);
        entry.busy = false;
        entry.lastUsed = Date.now();
      }
    },
  };
}
