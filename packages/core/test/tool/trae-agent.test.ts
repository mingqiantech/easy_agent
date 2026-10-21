import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTraeJson, createTraeTool } from "../../src/tool/builtins/trae-agent.js";

describe("parseTraeJson 防御解析", () => {
  it("标准 result+sessions 结构", () => {
    const p = parseTraeJson(JSON.stringify({ result: "任务完成", sessions: [{ session_id: "abc123" }] }));
    expect(p.result).toBe("任务完成");
    expect(p.sessionId).toBe("abc123");
  });
  it("error 字段透出", () => {
    const p = parseTraeJson(JSON.stringify({ error: "Models is required" }));
    expect(p.error).toBe("Models is required");
    expect(p.result).toBe("");
  });
  it("非 JSON 输出原样返回（旧版/text 模式）", () => {
    const p = parseTraeJson("纯文本结论 here");
    expect(p.result).toBe("纯文本结论 here");
  });
  it("response/message 别名兜底", () => {
    expect(parseTraeJson(JSON.stringify({ message: "hi" })).result).toBe("hi");
    expect(parseTraeJson(JSON.stringify({ response: "ho" })).result).toBe("ho");
  });
  it("实测 0.121.3 结构：message.content + 顶层 session_id + response_meta.usage", () => {
    const p = parseTraeJson(JSON.stringify({
      session_id: "943c7d83-x",
      message: { role: "assistant", content: "棒", response_meta: { usage: { prompt_tokens: 12566, completion_tokens: 3, prompt_token_details: { cached_tokens: 7424 } } } },
      stats: { model_usage: { "GLM-5.3": { input_tokens: 12566 } } },
    }));
    expect(p.result).toBe("棒");
    expect(p.sessionId).toBe("943c7d83-x");
    expect(p.usage).toEqual({ promptTokens: 12566, completionTokens: 3, cacheReadTokens: 7424 });
  });
});

describe("trae_agent 工具", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trae-tool-test-"));
  const fakeBin = path.join(tmp, "fake-trae.sh");
  fs.writeFileSync(
    fakeBin,
    [
      "#!/bin/bash",
      'PROMPT="${@: -1}"',
      '[[ "$PROMPT" == *"FAIL"* ]] && echo \'{"error":"boom"}\' && exit 0',
      '[[ "$PROMPT" == *"SLOW"* ]] && sleep 30 && echo \'{"result":"late"}\' && exit 0',
      'echo \'{"result":"done: ok","session_id":"sess-42"}\'',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const ctx: any = { sessionId: "s1", agentId: "default", workDir: tmp };

  it("成功调用：result/sessionId 提取", async () => {
    const tool = createTraeTool({ bin: fakeBin });
    const out: any = await tool.execute({ prompt: "做个任务" }, ctx);
    expect(out.result).toContain("done: ok");
    expect(out.sessionId).toBe("sess-42");
    expect(out.error).toBeUndefined();
  });
  it("workdir 围栏：白名单外拒绝", async () => {
    const tool = createTraeTool({ bin: fakeBin, allowedWorkdirs: [tmp] });
    const out: any = await tool.execute({ prompt: "x", workdir: "/etc" }, ctx);
    expect(out.error).toContain("不在允许列表");
  });
  it("error 输出透传", async () => {
    const tool = createTraeTool({ bin: fakeBin });
    const out: any = await tool.execute({ prompt: "FAIL please" }, ctx);
    expect(out.error).toContain("boom");
  });
  it("超时（timeoutMinutes 极小）不悬挂", async () => {
    const tool = createTraeTool({ bin: fakeBin });
    const out: any = await tool.execute({ prompt: "SLOW", timeoutMinutes: 1 / 60000 }, ctx); // 1s
    expect(out.error).toContain("超时");
  });
  it("bin 不存在 → 清晰错误而非堆栈", async () => {
    const tool = createTraeTool({ bin: path.join(tmp, "nope") });
    const out: any = await tool.execute({ prompt: "x" }, ctx);
    expect(out.error).toContain("不存在");
  });
});
