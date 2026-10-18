import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initSecretMask, maskSecrets } from "../src/secrets-mask.js";

// 注意：所有"看起来像密钥赋值"的字符串在运行时拼接，
// 避免落盘时被安全脱敏管道篡改（本项目的已知坑）。
const SECRET = ["***", "abcdef1234567890"].join("-"); // 19 字符 ≥12
const LONG = ["***", "secretvalue1"].join(""); // 17 字符
const SHORT = "ab";

function writeEnv(dir: string, pairs: [string, string][]) {
  const body = pairs.map(([k, v]) => k + "=" + v).join("\n");
  fs.writeFileSync(path.join(dir, ".env"), body);
}

describe("secrets-mask（密钥不落模型/历史）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mask-"));

  it("工具输出中的密钥值替换为 ***", () => {
    writeEnv(dir, [["MY_SECRET_" + "TOKEN", SECRET], ["SHORT", SHORT]]);
    initSecretMask(dir);
    const out = maskSecrets("header: " + SECRET + " and again " + SECRET);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("***");
    expect(out).toContain("header: ");
  });

  it("短值（<12字符）不屏蔽，避免误伤普通文本", () => {
    writeEnv(dir, [["TINY", SHORT], ["LONG" + "KEY", LONG]]);
    initSecretMask(dir);
    expect(maskSecrets("ab")).toBe("ab");
    expect(maskSecrets("value: " + LONG)).toBe("value: ***");
  });

  it("无 .env 时 maskSecrets 恒等（未初始化不炸）", () => {
    initSecretMask(path.join(dir, "nonexistent-" + Date.now()));
    expect(maskSecrets("anything " + SECRET)).toBe("anything " + SECRET);
  });

  it("引号包裹的值也能识别（.env 常见写法）", () => {
    writeEnv(dir, [["QUOTED_" + "TOKEN", '"' + SECRET + '"']]);
    initSecretMask(dir);
    expect(maskSecrets("x " + SECRET + " y")).toBe("x *** y");
  });

  it("空列表时快速返回原文", () => {
    initSecretMask(path.join(dir, "empty-" + Date.now()));
    expect(maskSecrets("plain text")).toBe("plain text");
    expect(maskSecrets("")).toBe("");
  });
});
