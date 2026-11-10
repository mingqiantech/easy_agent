import { describe, it, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** uploads 引用感知回收（2026-11-10）测试 */
const UP = fs.mkdtempSync(path.join(os.tmpdir(), "ea-purge-"));
process.env.EASY_AGENT_UPLOADS_DIR = UP;

const { purgeUploads } = await import("../src/uploads.js");
const { getDatabase } = await import("@easy-agent/core/database");

function mk(name: string, daysAgo: number) {
  const p = path.join(UP, name);
  fs.writeFileSync(p, "x".repeat(100));
  const t = (Date.now() - daysAgo * 86400_000) / 1000;
  fs.utimesSync(p, t, t);
}

describe("purgeUploads（引用感知回收）", () => {
  beforeAll(() => {
    // 全量跑时 getDatabase 已被其它测试文件初始化共享（单例）：用唯一 id + OR IGNORE
    const db = getDatabase(":memory:");
    db.prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_id, model, status, created_at, updated_at) VALUES ('purge-s1','a','m','active',?,?)",
    ).run(Date.now(), Date.now());
    // 消息1：content 引用 show-a.png；metadata.images 引用 uuid-b.jpg
    db.prepare(
      "INSERT OR IGNORE INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?,?,?,?,?,?)",
    ).run(
      "purge-m1",
      "purge-s1",
      "assistant",
      "看图 ![x](/uploads/show-a.png)",
      JSON.stringify({ images: [{ file: "uuid-b.jpg", mimeType: "image/jpeg" }] }),
      Date.now(),
    );
    // 归档消息引用 longtext-c.txt
    db.prepare(
      "INSERT OR IGNORE INTO messages_archive (id, session_id, role, content, metadata, created_at, archived_at) VALUES (?,?,?,?,?,?,?)",
    ).run("purge-m2", "purge-s1", "user", `[长文本已存文件：${path.join(UP, "longtext-c.txt")}]`, "{}", Date.now(), Date.now());
  });

  it("被引用文件不删（content/metadata/归档三路）；无引用且超保留期才删；新文件宽限", () => {
    mk("show-a.png", 30); // content 引用 → 保留
    mk("uuid-b.jpg", 30); // metadata 引用 → 保留
    mk("longtext-c.txt", 30); // 归档消息引用 → 保留
    mk("orphan-d.png", 15); // 无引用超期 → 删
    mk("fresh-e.png", 1); // 无引用但未到期 → 保留
    const r = purgeUploads(14);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(UP, "orphan-d.png"))).toBe(false);
    for (const keep of ["show-a.png", "uuid-b.jpg", "longtext-c.txt", "fresh-e.png"])
      expect(fs.existsSync(path.join(UP, keep))).toBe(true);
  });

  it("retentionDays<=0 关闭；目录不存在不报错", () => {
    expect(purgeUploads(0).removed).toBe(0);
    process.env.EASY_AGENT_UPLOADS_DIR = path.join(UP, "no-such-dir");
    expect(() => purgeUploads(14)).not.toThrow();
    process.env.EASY_AGENT_UPLOADS_DIR = UP;
  });
});
