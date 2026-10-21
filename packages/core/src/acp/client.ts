/**
 * 极简 ACP（Agent Client Protocol）客户端：换行分隔 JSON-RPC over stdio。
 * 角色=Client：spawn agent 进程（如 `trae-cli acp serve`），发 initialize/
 * session/new/session/prompt，收 session/update 通知与 server→client 请求
 * （session/request_permission 由 onServerRequest 决策）。
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface AcpRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: any };
}

export type ServerRequestHandler = (
  method: string,
  params: any,
) => Promise<any> | any;

export interface AcpConnectionOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** server→client 请求（权限审批等）；必须返回 result 对象，否则按错误回 * */
  onServerRequest?: ServerRequestHandler;
  /** session/update 等通知 */
  onNotification?: (method: string, params: any) => void;
  /** 单请求超时（默认 60s；prompt 用 requestTimeoutMs 单独放大） */
  requestTimeoutMs?: number;
  label?: string; // 日志标识
}

export class AcpConnection {
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private stderrTail = "";
  private closed = false;
  readonly label: string;

  constructor(private opts: AcpConnectionOptions) {
    this.label = opts.label ?? opts.bin;
    this.child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // 进程组：kill 时带走 agent 再生的子进程
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child.stdout.on("data", (d: Buffer) => this.onData(d));
    this.child.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-8192);
    });
    this.child.on("exit", (code) => this.failAll(new Error(`ACP 进程退出 code=${code}；stderr 尾部: ${this.stderrTail.slice(-300)}`)));
    this.child.on("error", (e: any) => this.failAll(new Error(`ACP 进程错误: ${e.message}`)));
  }

  private onData(d: Buffer) {
    this.buf += d.toString();
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: AcpRpcMessage;
      try { msg = JSON.parse(line); } catch { continue; } // 容忍非 JSON 杂行
      this.handle(msg);
    }
  }

  private handle(m: AcpRpcMessage) {
    if (m.id !== undefined && m.method) {
      // server→client 请求
      const respond = (result?: any, error?: any) => {
        if (this.closed) return;
        this.child.stdin.write(JSON.stringify(error ? { jsonrpc: "2.0", id: m.id, error } : { jsonrpc: "2.0", id: m.id, result: result ?? {} }) + "\n");
      };
      Promise.resolve()
        .then(() => this.opts.onServerRequest?.(m.method!, m.params))
        .then((r) => respond(r ?? {}))
        .catch((e) => respond(undefined, { code: -32603, message: String(e?.message ?? e) }));
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(Number(m.id));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(Number(m.id));
        if (m.error) p.reject(new Error(`${this.label}: ${m.error.message ?? "error"}${m.error.data ? " " + JSON.stringify(m.error.data).slice(0, 200) : ""}`));
        else p.resolve(m.result);
      }
      return;
    }
    if (m.method) this.opts.onNotification?.(m.method, m.params);
  }

  request(method: string, params: any, timeoutMs = this.opts.requestTimeoutMs ?? 60_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("ACP 连接已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 请求超时(${Math.round(timeoutMs / 1000)}s): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /** 运行期替换通知处理器（acp_agent 每轮 prompt 重装） */
  setNotificationHandler(h: ((method: string, params: any) => void) | undefined) {
    this.opts.onNotification = h;
  }

  get pid() { return this.child.pid; }
  get alive() { return !this.closed && this.child.exitCode === null; }

  kill(sig: NodeJS.Signals = "SIGTERM") {
    if (this.closed) return;
    try { process.kill(-this.child.pid!, sig); } catch { try { this.child.kill(sig); } catch {} }
  }

  close() {
    this.kill();
    this.closed = true;
    this.failAll(new Error("closed by client"));
  }

  private failAll(e: Error) {
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }
}
