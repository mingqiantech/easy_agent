import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { readTool } from "../../src/tool/builtins/read.js";

const TEST_DIR = "/tmp/easy-agent-test-read";

describe("read tool", () => {
  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(
      path.join(TEST_DIR, "hello.txt"),
      "line1\nline2\nline3\nline4\nline5",
      "utf-8",
    );
  });

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  const ctx = { sessionId: "test", agentId: "test", workDir: TEST_DIR };

  it("reads full file", async () => {
    const result = (await readTool.execute({ path: "hello.txt" }, ctx)) as any;
    expect(result.content).toBe("line1\nline2\nline3\nline4\nline5");
    expect(result.totalLines).toBe(5);
  });

  it("reads with offset and limit", async () => {
    const result = (await readTool.execute(
      { path: "hello.txt", offset: 2, limit: 2 },
      ctx,
    )) as any;
    expect(result.content).toBe("line2\nline3");
    expect(result.hasMore).toBe(true);
  });

  it("returns error for missing file", async () => {
    const result = (await readTool.execute({ path: "nope.txt" }, ctx)) as any;
    expect(result.error).toContain("not found");
  });
});
