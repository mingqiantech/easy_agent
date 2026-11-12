
describe("listMdFiles 子目录递归（2026-11-12 修 readdir.recursive 丢路径）", () => {
  it("memory/ 子目录（knowledge/archive/.dreams）下的 md 能被检索到", async () => {
    const fsx = await import("node:fs");
    const ospath = await import("node:path");
    const os = await import("node:os");
    const dir = fsx.mkdtempSync(ospath.join(os.tmpdir(), "ea-mdrec-"));
    const mem = ospath.join(dir, "memory");
    fsx.mkdirSync(ospath.join(mem, "knowledge"), { recursive: true });
    fsx.mkdirSync(ospath.join(mem, "archive"), { recursive: true });
    fsx.mkdirSync(ospath.join(mem, ".dreams", "session-corpus"), { recursive: true });
    fsx.writeFileSync(ospath.join(mem, "2026-11-11.md"), "# 日记\n普通关键词alpha 出现");
    fsx.writeFileSync(ospath.join(mem, "knowledge", "kp.md"), "# 知识点\n普通关键词beta 藏在知识文件里");
    fsx.writeFileSync(ospath.join(mem, "archive", "2026-08-01.md"), "# 归档日记\n普通关键词gamma 在归档");
    fsx.writeFileSync(ospath.join(mem, ".dreams", "session-corpus", "abc.md"), "# 会话语料\n普通关键词delta 在语料");
    const { MemorySearcher } = await import("../src/search.js");
    const searcher = new MemorySearcher(dir, mem);
    for (const [kw, want] of [
      ["普通关键词beta", "knowledge"],
      ["普通关键词gamma", "archive"],
      ["普通关键词delta", "session-corpus"],
      ["普通关键词alpha", "2026-11-11"],
    ] as const) {
      const r = await searcher.search(kw);
      expect(r.hits.some((h: any) => String(h.file ?? h.path).includes(want))).toBe(true);
    }
  });
});
