import { describe, it, expect, beforeAll } from "bun:test";
import { getDatabase } from "../../src/database.js";
import { SessionManager } from "../../src/session.js";
import { LLMClient } from "@easy-agent/llm/client";
import { ToolRegistry } from "../../src/tool/registry.js";
import { z } from "zod";

describe("SessionManager", () => {
  let sessions: SessionManager;

  beforeAll(() => {
    const db = getDatabase(":memory:");
    const llm = new LLMClient({ providers: {} });
    sessions = new SessionManager(llm, { defaultModel: "test/model" });
  });

  it("creates a session", () => {
    const s = sessions.create({ model: "test/model" });
    expect(s.id).toBeTruthy();
    expect(s.model).toBe("test/model");
    expect(s.status).toBe("active");
  });

  it("lists sessions", () => {
    const list = sessions.list();
    expect(list.length).toBeGreaterThan(0);
    // 回归测试：updateAt 曾因错误列名 row.update_at 恒为 undefined
    const s = list[0]!;
    expect(typeof s.updateAt).toBe("number");
    expect(s.updateAt).toBeGreaterThanOrEqual(s.createAt);
  });

  it("adds and retrieves messages", () => {
    const s = sessions.create({});
    sessions.addMessage(s.id, { role: "user", content: "hello" });
    sessions.addMessage(s.id, { role: "assistant", content: "hi" });
    const msgs = sessions.getMessages(s.id);
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].content).toBe("hi");
  });

  it("queueMessage 需要会话正在运行（转向/排队基础）", () => {
    const s = sessions.create({});
    expect(sessions.isBusy(s.id)).toBe(false);
    // 会话没在跑 → 不入队（调用方直接 run），不产生孤儿消息
    expect(sessions.queueMessage(s.id, "插话")).toBe(false);
    sessions.delete(s.id);
  });

  it("onEvent 流式路径：文本增量事件、落库与 token_usage 记录", async () => {
    const stub: any = {
      generate: () => {
        throw new Error("streaming 路径不应调用 generate");
      },
      stream: async function* () {
        yield { type: "text", text: "你好" };
        yield { type: "text", text: "世界" };
        yield {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const events: any[] = [];
    const out = await sm.run(s.id, "hi", {
      onEvent: (e: any) => events.push(e),
    });
    expect(out).toBe("你好世界");
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("你好世界");
    expect(sm.getMessages(s.id).filter((m) => m.role === "assistant").length).toBe(1);
    const u = getDatabase()
      .prepare("SELECT COUNT(*) n FROM token_usage WHERE session_id=?")
      .get(s.id) as any;
    expect(u.n).toBe(1);
  });

  it("deletes a session", () => {
    const s = sessions.create({});
    sessions.delete(s.id);
    expect(sessions.get(s.id)).toBeNull();
  });
});

describe("任意步 abort + 排队持久化", () => {
  it("abort 命中运行中会话：步骤边界即停，不再二次调用模型", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => {
        calls++;
        return {
          content: "第一段",
          toolCalls:
            calls === 1
              ? [{ id: "t1", name: "boom", input: {} }]
              : undefined,
          usage: undefined,
          finishReason: calls === 1 ? "tool_calls" : "stop",
        };
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const reg = new ToolRegistry();
    const s = sm.create({});
    reg.register({
      name: "boom",
      description: "执行中请求中断",
      inputSchema: z.object({}),
      execute: async (_i: any, ctx: any) => {
        sm.abort(ctx.sessionId); // 工具执行中触发 abort
        return { output: "part" };
      },
    });
    const out = await sm.run(s.id, "go", { toolRegistry: reg });
    expect(calls).toBe(1); // 第二步前在边界停下
    expect(out).toBe("第一段");
    expect(sm.isBusy(s.id)).toBe(false);
    expect(sm.abort(s.id)).toBe(false); // run 结束后无 controller
  });

  it("abort 未运行时返回 false", () => {
    const sm = new SessionManager(new LLMClient({ providers: {} }), {
      defaultModel: "test/model",
    });
    expect(sm.abort("nope")).toBe(false);
  });

  it("pending 落库：run 启动预载遗留行并作为转向消息消费，消费后删行", async () => {
    const stub: any = {
      generate: async () => ({
        content: "已处理",
        toolCalls: undefined,
        usage: undefined,
        finishReason: "stop",
      }),
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    sm.enqueuePending(s.id, "重启前遗留的排队消息");
    await sm.run(s.id, "主问题", {});
    const msgs = sm.getMessages(s.id);
    const users = msgs.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toContain("主问题");
    expect(users).toContain("重启前遗留的排队消息");
    const c = (
      getDatabase()
        .prepare("SELECT COUNT(*) c FROM pending_queue")
        .get() as any
    ).c;
    expect(c).toBe(0); // 消费即删，不残留
  });

  it("删除会话连带清除其 pending 行", () => {
    const sm = new SessionManager(new LLMClient({ providers: {} }), {
      defaultModel: "test/model",
    });
    const s = sm.create({});
    sm.enqueuePending(s.id, "x");
    expect(sm.delete(s.id)).toBe(true);
    const c = (
      getDatabase()
        .prepare(
          "SELECT COUNT(*) c FROM pending_queue WHERE session_id = ?",
        )
        .get(s.id) as any
    ).c;
    expect(c).toBe(0);
  });

  it("userText=null 恢复轮：遗留 pending 行作为首条消息续跑", async () => {
    const stub: any = {
      generate: async (req: any) => ({
        content: "已恢复:" + (req.messages.filter((m: any) => m.role === "user").pop()?.content ?? ""),
        toolCalls: undefined,
        usage: undefined,
        finishReason: "stop",
      }),
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    sm.enqueuePending(s.id, "重启前遗留A");
    sm.enqueuePending(s.id, "重启前遗留B");
    const out = await sm.run(s.id, null, {});
    expect(out).toContain("已恢复:");
    const users = sm.getMessages(s.id).filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toContain("重启前遗留A");
    expect(users).toContain("重启前遗留B"); // A 为首轮，B 经转向/尾队列消费
    const c = (
      getDatabase().prepare("SELECT COUNT(*) c FROM pending_queue").get() as any
    ).c;
    expect(c).toBe(0);
  });

  it("extraSystem：注入在头部 system 块之后、首条非 system 消息之前", async () => {
    const seen: any[] = [];
    const stub: any = {
      generate: async (req: any) => { seen.push(req.messages); return { content: "ok", toolCalls: [], finishReason: "stop" }; },
      stream: async function* (req: any) { seen.push(req.messages); yield { type: "text", text: "ok" }; yield { type: "done", finishReason: "stop" }; },
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({ systemPrompt: "基础系统提示" });
    await sm.run(s.id, "你好", { onEvent: () => {}, extraSystem: "外部工具引导：重活优先 trae_agent" });
    const msgs = seen[0];
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("基础系统提示"); // 基础 prompt 前缀不变（缓存友好）
    expect(msgs[1].role).toBe("system");
    expect(msgs[1].content).toContain("trae_agent");
    expect(msgs[2].role).toBe("user");
    // 未传 extraSystem 的下一轮：不注入
    await sm.run(s.id, "再来", { onEvent: () => {} });
    expect(seen[1][1].role).toBe("user");
  });

  it("userText=null 的空恢复轮：无遗留时立即返回且不写消息", async () => {
    const stub: any = {
      generate: async () => {
        throw new Error("不应调用模型");
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const out = await sm.run(s.id, null, {});
    expect(out).toBe("");
    expect(sm.getMessages(s.id).length).toBe(0);
  });

  it("空响应：静默重试一次后落占位消息，历史不断档", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => { calls++; return { content: "", toolCalls: [], usage: undefined, finishReason: "stop" }; },
      stream: async function* () { calls++; },
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const out = await sm.run(s.id, "hi", { onEvent: () => {} });
    expect(out).toBe("");
    expect(calls).toBe(2); // 原始一次 + 重试一次
    const msgs = sm.getMessages(s.id);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("未返回内容");
  });

  it("空响应后第二轮恢复正常：占位只在空轮出现", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => ({ content: "", toolCalls: [], finishReason: "stop" }),
      stream: async function* () {
        calls++;
        if (calls > 2) { yield { type: "text", text: "恢复了" }; yield { type: "done", finishReason: "stop" }; }
      },
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    await sm.run(s.id, "hi", { onEvent: () => {} });
    const out2 = await sm.run(s.id, "再试", { onEvent: () => {} });
    expect(out2).toBe("恢复了");
    const msgs = sm.getMessages(s.id);
    expect(msgs.filter((m: any) => m.role === "assistant" && m.content.includes("未返回内容")).length).toBe(1);
  });
});

describe("步数封顶收口（跑完工具没回复修复）", () => {
  const toolReg = () => {
    const reg = new ToolRegistry();
    reg.register({
      name: "tick",
      description: "计数工具",
      inputSchema: z.object({}),
      execute: async () => ({ output: "ok" }),
    });
    return reg;
  };

  it("20 步卡在工具轮 → 补一次无工具收口，终文落库且返回", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => {
        calls++;
        if (calls > 20)
          return { content: "阶段总结：已查明部分事实", toolCalls: [], finishReason: "stop" };
        return {
          content: "",
          toolCalls: [{ id: `t${calls}`, name: "tick", input: {} }],
          finishReason: "tool_calls",
        };
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const out = await sm.run(s.id, "查个复杂问题", { toolRegistry: toolReg() });
    expect(calls).toBe(21); // 20 工具轮 + 1 次收口
    expect(out).toContain("阶段总结");
    const last = sm.getMessages(s.id).slice(-1)[0] as any;
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("阶段总结");
  });

  it("收口也空 → 落‘步数已达上限’占位，返回值非空避免误报空响应", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => {
        calls++;
        if (calls > 20) return { content: "", toolCalls: [], finishReason: "stop" };
        return {
          content: "",
          toolCalls: [{ id: `t${calls}`, name: "tick", input: {} }],
          finishReason: "tool_calls",
        };
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const out = await sm.run(s.id, "go", { toolRegistry: toolReg() });
    expect(out).toContain("步数已达上限");
    expect(sm.getMessages(s.id).slice(-1)[0].content).toContain("继续");
  });

  it("正常最终文本轮不触发收口（无多余调用）", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => {
        calls++;
        return calls === 1
          ? { content: "", toolCalls: [{ id: "t1", name: "tick", input: {} }], finishReason: "tool_calls" }
          : { content: "最终答案", toolCalls: [], finishReason: "stop" };
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const s = sm.create({});
    const out = await sm.run(s.id, "go", { toolRegistry: toolReg() });
    expect(calls).toBe(2);
    expect(out).toBe("最终答案");
  });
});

describe("同轮多工具并行执行", () => {
  it("两个慢工具并发跑（总耗时≈单个而非两倍），结果按原序落库", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => {
        calls++;
        return calls === 1
          ? { content: "", toolCalls: [
              { id: "a", name: "slow", input: {} },
              { id: "b", name: "slower", input: {} },
            ], finishReason: "tool_calls" }
          : { content: "done", toolCalls: [], finishReason: "stop" };
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const reg = new ToolRegistry();
    const started: string[] = [];
    reg.register({ name: "slow", description: "慢A", inputSchema: z.object({}),
      execute: async () => { started.push("slow"); await new Promise((r) => setTimeout(r, 60)); return { output: "A" }; } });
    reg.register({ name: "slower", description: "慢B", inputSchema: z.object({}),
      execute: async () => { started.push("slower"); await new Promise((r) => setTimeout(r, 60)); return { output: "B" }; } });
    const s = sm.create({});
    const t0 = Date.now();
    const out = await sm.run(s.id, "go", { toolRegistry: reg });
    const dt = Date.now() - t0;
    expect(out).toBe("done");
    expect(dt).toBeLessThan(110); // 串行要 ≥120ms
    expect(started.length).toBe(2);
    const toolMsgs = sm.getMessages(s.id).filter((m: any) => m.role === "tool") as any[];
    expect(toolMsgs.length).toBe(2);
    // 原序：a 在前 b 在后（并行完成顺序无所谓，落库跟随 toolCalls 顺序）
    expect(JSON.parse(toolMsgs[0].content).toolCallId).toBe("a");
    expect(JSON.parse(toolMsgs[1].content).toolCallId).toBe("b");
  });

  it("单个工具抛异常不连坐同批其他工具（catch 成 error 字段落库）", async () => {
    let calls = 0;
    const stub: any = {
      generate: async () => {
        calls++;
        return calls === 1
          ? { content: "", toolCalls: [
              { id: "x", name: "boom", input: {} },
              { id: "y", name: "fine", input: {} },
            ], finishReason: "tool_calls" }
          : { content: "ok", toolCalls: [], finishReason: "stop" };
      },
      stream: async function* () {},
    };
    const sm = new SessionManager(stub, { defaultModel: "test/model" });
    const reg = new ToolRegistry();
    reg.register({ name: "boom", description: "炸", inputSchema: z.object({}), execute: async () => { throw new Error("kapow"); } });
    reg.register({ name: "fine", description: "好", inputSchema: z.object({}), execute: async () => ({ output: "good" }) });
    const s = sm.create({});
    const out = await sm.run(s.id, "go", { toolRegistry: reg });
    expect(out).toBe("ok");
    const toolMsgs = sm.getMessages(s.id).filter((m: any) => m.role === "tool") as any[];
    expect(toolMsgs.length).toBe(2);
    // registry 自带 catch（error 字段），并行 wrapper 的 catch 仅兜底注册器漏网异常
    expect(JSON.parse(toolMsgs[0].content).error).toContain("kapow");
    expect(JSON.parse(toolMsgs[1].content).result.output).toBe("good");
  });
});
