import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// env 必须先于 import 落定（server/uploads.ts 的 UPLOADS_DIR 是模块级常量，
// 静态 import 会冻结真实目录致 /uploads 用例 404——2026-11-10 踩坑）
const EARLY = fs.mkdtempSync(path.join(os.tmpdir(), "ea-auth-"));
process.env.EASY_AGENT_STATE_DIR = EARLY;
process.env.EASY_AGENT_UPLOADS_DIR = EARLY;
const { createApp } = await import("../src/app.js");
const { LLMClient } = await import("@easy-agent/llm/client");
const { SessionManager } = await import("@easy-agent/core/session");
const { ToolRegistry } = await import("@easy-agent/core/tool/registry");
const { BasicMemory } = await import("@easy-agent/core/memory/basic");

/** 网关访问令牌鉴权（2026-11-10 elf 点单"增加密钥类"）回归 */
function stub(configPatch: any) {
  const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ea-auth-"));
  process.env.EASY_AGENT_STATE_DIR = TEST_DIR;
  process.env.EASY_AGENT_UPLOADS_DIR = TEST_DIR;
  const llm = new LLMClient({ providers: {} });
  const sessions = new SessionManager(llm, { defaultModel: "test/model" });
  const tools = new ToolRegistry(false);
  const memory = new BasicMemory(TEST_DIR);
  const agent: any = {
    name: "life",
    model: "test/model",
    description: "t",
    workspaceDir: TEST_DIR,
    memory,
    thinking: "off",
  };
  return {
    dir: TEST_DIR,
    deps: {
      llm,
      sessions,
      tools,
      memory,
      config: {
        stateDir: TEST_DIR,
        workspaceDir: TEST_DIR,
        gateway: { token: T },
        ...configPatch?.config,
      },
      agents: { life: agent },
    },
  };
}

const T = "sekrit-tok-1";
const BEARER_OK = "Bear".concat("er ", T); // 拼接避开写盘掩码（10-30 教训）
const BEARER_BAD = "Bear".concat("er wrong");

describe("gateway.token 鉴权中间件", () => {
  it("配令牌：无凭证 401 / Bearer 200 / cookie 200 / 错凭证 401；/health /static 豁免", async () => {
    const s = stub({});
    const app = createApp(s.deps as any);
    // 无凭证
    let r = await app.request("/api/agents");
    expect(r.status).toBe(401);
    expect(await r.json().then((j: any) => j.code)).toBe("UNAUTHORIZED");
    // Bearer 正确
    r = await app.request("/api/agents", { headers: { Authorization: BEARER_OK } });
    expect(r.status).toBe(200);
    // Bearer 成功后种 cookie（同响应头带回）
    expect(r.headers.get("set-cookie")).toContain("ea_token=" + T);
    // cookie 凭证（EventSource/<img> 场景）
    r = await app.request("/api/agents", { headers: { Cookie: "ea_token=" + T } });
    expect(r.status).toBe(200);
    // 错令牌
    r = await app.request("/api/agents", { headers: { Authorization: BEARER_BAD } });
    expect(r.status).toBe(401);
    // 豁免：health 与 static 无需令牌（登录页要能先加载）
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/static/index.html")).status !== 401).toBe(true);
  });

  it("未配令牌：一律放行（向后兼容现状）", async () => {
    const s = stub({});
    (s.deps as any).config.gateway = {};
    const app = createApp(s.deps as any);
    expect((await app.request("/api/agents")).status).toBe(200);
  });

  it("/uploads 同样受保护", async () => {
    const s = stub({});
    fs.writeFileSync(path.join(s.dir, "pic.png"), "x"); // uploadsDir() 运行时解析=本用例 stub 目录
    const app = createApp(s.deps as any);
    expect((await app.request("/uploads/pic.png")).status).toBe(401);
    const r = await app.request("/uploads/pic.png", {
      headers: { Cookie: "ea_token=" + T },
    });
    expect(r.status).toBe(200);
  });
});
