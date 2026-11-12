import { Database } from "bun:sqlite";
import fs from "node:fs";
import { loadConfig } from "@easy-agent/config/loader";
import { LLMClient } from "@easy-agent/llm/client";
const { collectDistillInput } = await import("./src/knowledge.js");

const sid = "01M5Y2ZQMVAGAWMZKGZANJ2EPH";
const DAY = 86400000, cutoff = Date.now() - 10 * DAY;
const db = new Database(process.env.HOME + "/.easy-agent/agent.db");
db.exec("PRAGMA foreign_keys = ON");

// 1) 恢复十天内被全量换届误归档的聊天（含同期 [对话摘要] 条）
const restored = db.run(
  `INSERT INTO messages (id, session_id, role, content, metadata, created_at)
   SELECT id, session_id, role, content, COALESCE(NULLIF(metadata,''),'{}'), created_at
   FROM messages_archive
   WHERE session_id = ? AND created_at >= ?
     AND (role != 'system' OR content LIKE '[对话摘要]%')`,
);
db.run(
  `DELETE FROM messages_archive WHERE session_id = ? AND created_at >= ?
     AND (role != 'system' OR content LIKE '[对话摘要]%')`,
);
console.log("恢复近期消息:", restored.changes);

// 2) 旧段（<10 天，仍在归档区）重组蒸馏输入 → 续写生成规范知识卡
const old = db
  .prepare(
    `SELECT role, content, created_at FROM messages_archive
     WHERE session_id = ? AND created_at < ? AND content NOT LIKE '【知识要点】%'
     ORDER BY created_at`,
  )
  .all(sid, cutoff) as any[];
const input = collectDistillInput(old);
console.log("旧段原文:", old.length, "条 → 蒸馏输入", input?.length ?? 0, "字符");
const config = loadConfig();
const llm = new LLMClient({ providers: config.providers });
const SYSTEM =
  "你是知识提炼助手。把下面的对话记录提炼为「知识点清单」，中文 Markdown：\n## 结论与事实\n（按主题分组，每条一行，保留具体数字/型号/价格/命令/结论等硬信息）\n## 方法与经验\n（可复用的做法、踩过的坑）\n## 未决问题\n（没有就省略）\n只写有信息量的条目；**宁全勿简**，篇幅随内容走；务必覆盖全部主题，最后收束。";
let body = "";
{
  const m: any[] = [{ role: "user", content: input }];
  for (let seg = 0; seg < 4; seg++) {
    const resp: any = await llm.generate({ model: config.defaultModel, system: SYSTEM, messages: m, generation: { maxTokens: 2600 } });
    body += String(resp.content ?? "");
    if (resp.finishReason !== "length" || seg === 3) break;
    console.log("✂️ 段", seg + 1, "截断，续写…");
    m.push({ role: "assistant", content: body }, { role: "user", content: "从断点继续，只写后半截，勿重复已输出；覆盖全部主题后收束" });
  }
  body = body.trim();
}
console.log("知识卡全文:", body.length, "字 | 尾部:", body.slice(-30).replace(/\n/g, " "));

// 3) 活跃卡替换：内容更新 + 时间戳钉到近期对话之前（渲染顺序：头部→卡→近期聊天）
const minRecent = (db.prepare("SELECT MIN(created_at) t FROM messages WHERE session_id=? AND role!='system'").get(sid) as any).t ?? Date.now();
const card = db.prepare("SELECT id FROM messages WHERE session_id=? AND content LIKE '【知识要点】%' ORDER BY created_at DESC LIMIT 1").get(sid) as any;
if (card) db.run("UPDATE messages SET content=?, created_at=? WHERE id=?", ["【知识要点】\n" + body, minRecent - 1, card.id]);
else db.run("INSERT INTO messages (id,session_id,role,content,metadata,created_at) VALUES (?,?,?,?,?,?)", [Date.now().toString(36) + "-kp", sid, "system", "【知识要点】\n" + body, "{}", minRecent - 1]);

// 4) 知识文件同步（替换偏题旧版）
const f = process.env.HOME + "/.easy-agent/workspaces/tech/memory/knowledge/2026-11-12_首页.md";
fs.writeFileSync(f, `# 知识点 · 首页\n\n> 蒸馏自 ${new Date(old[0]?.createdAt ?? 0).toLocaleDateString("zh-CN")}–${new Date(old[old.length - 1]?.createdAt ?? 0).toLocaleDateString("zh-CN")} 的对话（${old.length} 条，已归档可查）；10 天内聊天已原位恢复。\n\n${body}\n`);
console.log("文件更新:", f.split("/").pop());

const live = db.prepare("SELECT role, COUNT(*) c FROM messages WHERE session_id=? GROUP BY role").all(sid) as any[];
console.log("页面现存消息:", JSON.stringify(live));
