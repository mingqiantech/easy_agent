import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export interface ClusterOptions {
  instances?: number;
  basePort?: number;
}

/**
 * 多实例启动器（Week 12 高可用）
 * 同进程监听多个端口，配合 nginx/Caddy 做负载均衡。
 * SQLite 走 WAL，多进程读并发安全；写由各实例短事务承担。
 */
export function startCluster(
  createApp: () => Hono,
  options: ClusterOptions = {},
): Array<{ port: number; close: () => void }> {
  const instances = Math.max(1, options.instances ?? 1);
  const basePort = options.basePort ?? Number(process.env.PORT ?? 4096);

  const servers: Array<{ port: number; close: () => void }> = [];

  for (let i = 0; i < instances; i++) {
    const port = basePort + i;
    const app = createApp();
    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`✓ instance ${i + 1}/${instances} listening on :${port}`);
    });
    servers.push({ port, close: () => server.close() });
  }

  console.log(
    `🚀 cluster: ${instances} instance(s), ports ${basePort}..${basePort + instances - 1}`,
  );

  // 优雅退出
  const shutdown = () => {
    console.log("\nShutting down instances...");
    for (const s of servers) {
      try {
        s.close();
      } catch {
        // 已关闭
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return servers;
}
