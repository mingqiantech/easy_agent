import { Database } from "bun:sqlite";
import fs from "node:fs";
import { loadConfig } from "@easy-agent/config/loader";
import { LLMClient } from "@easy-agent/llm/client";
import { buildDistillLines, packChunks, generateKnowledge, mergeKnowledgeSections } from "./src/knowledge.js";

const sid = "01M5Y2ZQMVAGAWMZKGZANJ2EPH";
const DAY = 86400000, cutoff = Date.now() - 10 * DAY;
const db = new Database(process.env.HOME + "/.easy-agent/agent.db");
const old = db.prepare(
  `SELECT role, content, created_at FROM messages_archive
   WHERE session_id=? AND created_at<? AND content NOT LIKE '【知识要点】%' ORDER BY created_at`,
).all(sid, cutoff) as any[];
const lines = buildDistillLines(old);
const chunks = packChunks(lines);
console.log(`旧段 ${old.length} 条 → ${lines.length} 行 → ${chunks.length} 块`);

const config = loadConfig();
const llm = new LLMClient({ providers: config.providers });
let body = "";
for (const [i, c] of chunks.entries()) {
  const part = await generateKnowledge(llm, config.defaultModel, c);
  console.log(`块 ${i + 1}/${chunks.length}: ${part.length} 字, 节数 ${[...part.matchAll(/^## /gm)].length}`);
  if (part.length >= 40) body += (body ? "\n\n" : "") + part;
}
body = mergeKnowledgeSections(body);
const topics = [...body.matchAll(/^## (.+)$/gm)].map((x) => x[1]!);
console.log("合并后:", body.length, "字 |", topics.length, "个主题:", topics.join(" / "));
if (topics.length < 4) { console.log("⚠️ 主题数异常，不回写"); process.exit(1); }

db.prepare("UPDATE messages SET content=? WHERE session_id=? AND content LIKE '【知识要点】%'").run("【知识要点】\n" + body, sid);
fs.writeFileSync(process.env.HOME + "/.easy-agent/workspaces/tech/memory/knowledge/2026-11-12_首页.md",
  `# 知识点 · 首页\n\n> 蒸馏自 ${new Date(old[0]!.createdAt).toLocaleDateString("zh-CN")}–${new Date(old[old.length - 1]!.createdAt).toLocaleDateString("zh-CN")} 的对话（${old.length} 条，按主题分节，归档可查）。\n\n${body}\n`);
console.log("✅ 卡+知识文件已替换");
