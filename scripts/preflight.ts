import fs from "node:fs/promises";
import path from "node:path";

/**
 * 上线前检查（Week 8）
 * 用法: bun run scripts/preflight.ts
 */

interface Check {
  name: string;
  required: boolean;
  run: () => Promise<{ ok: boolean; message: string }>;
}

const checks: Check[] = [
  {
    name: "运行时版本",
    required: true,
    run: async () => {
      const v = process.versions.bun;
      if (v) return { ok: true, message: `Bun ${v}` };
      const major = parseInt(process.versions.node.split(".")[0]);
      return major >= 20
        ? { ok: true, message: `Node.js ${process.versions.node}` }
        : { ok: false, message: `Node.js ${process.versions.node} (需要 >=20)` };
    },
  },
  {
    name: "API Key 配置",
    required: true,
    run: async () => {
      const has = !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY;
      return { ok: has, message: has ? "已配置" : "未配置（OPENAI_API_KEY / ANTHROPIC_API_KEY）" };
    },
  },
  {
    name: "状态目录可写",
    required: true,
    run: async () => {
      const dir =
        process.env.EASY_AGENT_STATE_DIR ??
        path.join(process.env.HOME ?? "/tmp", ".local", "share", "easy-agent");
      try {
        await fs.mkdir(dir, { recursive: true });
        const probe = path.join(dir, ".preflight-probe");
        await fs.writeFile(probe, "x");
        await fs.unlink(probe);
        return { ok: true, message: dir };
      } catch (e: any) {
        return { ok: false, message: `${dir}: ${e.message}` };
      }
    },
  },
  {
    name: "package.json 存在",
    required: true,
    run: async () => {
      try {
        await fs.access("package.json");
        return { ok: true, message: "ok" };
      } catch {
        return { ok: false, message: "缺少 package.json（请在项目根目录运行）" };
      }
    },
  },
  {
    name: "MEMORY.md",
    required: false,
    run: async () => {
      try {
        const stat = await fs.stat("MEMORY.md");
        return { ok: true, message: `存在 (${stat.size} bytes)` };
      } catch {
        return { ok: false, message: "不存在（首次启动会自动创建）" };
      }
    },
  },
  {
    name: ".gitignore 覆盖敏感文件",
    required: true,
    run: async () => {
      try {
        const content = await fs.readFile(".gitignore", "utf-8");
        const ok = content.includes("node_modules") && content.includes(".env");
        return { ok, message: ok ? "已覆盖" : "缺少 node_modules/ 或 .env 规则" };
      } catch {
        return { ok: false, message: "缺少 .gitignore" };
      }
    },
  },
  {
    name: "源码无硬编码 API Key",
    required: true,
    run: async () => {
      const offenders: string[] = [];
      const files = await Array.fromAsync(
        new Bun.Glob("packages/**/src/**/*.{ts,json}").scan({ dot: false }),
      );
      for (const file of files) {
        const content = await Bun.file(file).text().catch(() => "");
        // sk- 开头且 20+ 字符视为疑似真实 key（排除示例占位）
        if (/sk-[A-Za-z0-9]{20,}/.test(content) && !content.includes("sk-xxx")) {
          offenders.push(file);
        }
      }
      return {
        ok: offenders.length === 0,
        message: offenders.length === 0 ? "干净" : `疑似硬编码: ${offenders.join(", ")}`,
      };
    },
  },
];

console.log("\n🔍 Pre-flight Check\n");

let allRequiredOk = true;
for (const check of checks) {
  const result = await check.run();
  const icon = result.ok ? "✅" : check.required ? "❌" : "⚠️";
  console.log(`  ${icon} ${check.name}: ${result.message}`);
  if (!result.ok && check.required) allRequiredOk = false;
}

console.log("");
if (allRequiredOk) {
  console.log("✅ 所有必检项通过，可以启动。\n");
} else {
  console.log("❌ 存在未通过的必检项，请先修复。\n");
  process.exit(1);
}
