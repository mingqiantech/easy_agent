import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { decideRevision, applyRevision } = await import("../src/knowledge.js");

const FILE = [
  "# 知识点 · CAN 调试",
  "",
  "> 蒸馏自 10-01–11-01 的会话",
  "",
  "## 结论与事实",
  "- F405 CAN 用 42MHz APB1，BRP=15 可到 1Mbps",
  "",
  "## 方法",
  "- 先示波验证再上总线",
  ""
].join("\n");

const llmReturning = (content: string): any => ({
  generate: async () => ({ content }),
});

describe("decideRevision（修订判定 + 安全闸门）", () => {
  const fresh = [{ excerpt: "实测纠正：BRP=15 算不出 1M，正确 SJW=1/TMS=8/BRS=15 配 BRP=3", ts: Date.now() }];

  it("合法 revise：保标题+够长 → 采用", async () => {
    const out = JSON.stringify({
      action: "revise",
      reason: "BRP 结论被新实测推翻",
      newContent: FILE.replace("BRP=15 可到 1Mbps", "BRP=3 可到 1Mbps") + "\n> 修订 2026-11-12：BRP 结论已被实测纠正\n",
    });
    const a = await decideRevision(llmReturning(out), "m", FILE, fresh, "2026-11-12");
    expect(a.action).toBe("revise");
    expect(a.newContent).toContain("BRP=3");
    expect(a.newContent).toContain("修订 2026-11-12");
  });

  it("围栏 JSON 也能解析", async () => {
    const out = "```json\n" + JSON.stringify({ action: "none" }) + "\n```";
    expect((await decideRevision(llmReturning(out), "m", FILE, fresh, "d")).action).toBe("none");
  });

  it("newContent 丢掉原标题（疑似换题/摘要）→ 拒，降为 none", async () => {
    const out = JSON.stringify({ action: "revise", reason: "x", newContent: "全新的一页别的知识，和 CAN 无关。".repeat(40) });
    expect((await decideRevision(llmReturning(out), "m", FILE, fresh, "d")).action).toBe("none");
  });

  it("newContent 过短（防截肢改写）→ none", async () => {
    const out = JSON.stringify({ action: "revise", newContent: "# 知识点 · CAN 调试\n就一句话" });
    expect((await decideRevision(llmReturning(out), "m", FILE, fresh, "d")).action).toBe("none");
  });

  it("LLM 输出非 JSON / 非法 action → none；无新料 → none 不发调用", async () => {
    expect((await decideRevision(llmReturning("我觉得要改一下"), "m", FILE, fresh, "d")).action).toBe("none");
    expect((await decideRevision(llmReturning(JSON.stringify({ action: "nuke" })), "m", FILE, fresh, "d")).action).toBe("none");
    const zeroCalls: any = { generate: async () => { throw new Error("不该被调用"); } };
    expect((await decideRevision(zeroCalls, "m", FILE, [], "d")).action).toBe("none");
  });
});

describe("applyRevision（回写）", () => {
  it("revise 整体替换；void 文件头插作废标记且幂等", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-rev-"));
    const file = path.join(dir, "k.md");
    fs.writeFileSync(file, FILE);
    expect(applyRevision(file, { action: "revise", newContent: FILE + "\n> 修订 d：x" }, "d")).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toContain("修订 d");
    expect(applyRevision(file, { action: "void", reason: "被推翻" }, "d2")).toBe(true);
    expect(fs.readFileSync(file, "utf-8").startsWith("<!--voided d2")).toBe(true);
    expect(applyRevision(file, { action: "void", reason: "再void" }, "d3")).toBe(false); // 已作废不重复
    expect(applyRevision(path.join(dir, "nope.md"), { action: "revise", newContent: "x" }, "d")).toBe(false);
  });
});
