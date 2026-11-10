import fs from "node:fs";
import path from "node:path";
import { WeComAdapter } from "./bot.js";
import { loadConfig } from "@easy-agent/config/loader";
import { getStateDir } from "@easy-agent/config/path";

/**
 * 方案 B：企微通道 = 4096 网关的桥接进程（不再本地起会话）。
 * 消息 → POST /api/sessions/:id/messages → 网关（workspace 记忆 + 工具 + agent 路由）
 * 会话按 chatId 稳定映射；agent 选择优先级（2026-10-31）：
 *   配置固定 wecom.chatAgents > 「切换」指令（持久化到 <stateDir>/wecom-chat-agents.json，
 *   重启不丢） > wecom.agentId 缺省。
 */

const GW = process.env.EASY_AGENT_GATEWAY ?? "http://127.0.0.1:4096";
/** uploads 目录：与网关同机同盘（server/uploads.ts 同规则；运行时解析 env） */
const UPLOADS_DIR =
  process.env.EASY_AGENT_UPLOADS_DIR ??
  path.join(process.env.HOME ?? "/home", ".easy-agent", "uploads");

interface BridgeState {
  sessionId: string;
  agentId: string;
}

/** 网关访问令牌（2026-11-10）：main() 从 env/config 解析后注入；网关开鉴权时桥接免 401 */
let GW_TOKEN = String();

async function gwFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(GW + path, {
    headers: {
      "Content-Type": "application/json",
      ...(GW_TOKEN ? { Authorization: `Bearer ${GW_TOKEN}` } : {}),
    },
    ...init,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** 从消息存中提 assistant 正文（content 可能是 {text,toolCalls} JSON 或纯文本） */
function assistantText(m: any): string {
  if (m.role !== "assistant") return "";
  try {
    const parsed = JSON.parse(m.content);
    return String(parsed?.text ?? "");
  } catch {
    return String(m.content ?? "");
  }
}

/** 网关返回 202 queued（上一轮还在跑）：轮询新 assistant 消息直到出结果 */
async function waitForReply(sessionId: string, beforeCount: number, timeoutMs = 10 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const { messages } = await gwFetch(`/api/sessions/${sessionId}/messages`);
    for (let i = messages.length - 1; i >= beforeCount; i--) {
      const t = assistantText(messages[i]);
      if (t.trim()) return t;
    }
  }
  return "⛱ 处理超时（10 分钟），可到网页端查看该会话结果";
}

/** 取/建某会话对应的网关 session（agent 变更时重建，保留旧会话在网页端可查） */
async function ensureSession(
  map: Map<string, BridgeState>,
  chatKey: string,
  agentId: string,
): Promise<BridgeState> {
  const cur = map.get(chatKey);
  if (cur && cur.agentId === agentId) return cur;
  const { session } = await gwFetch("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  const st = { sessionId: session.id, agentId };
  map.set(chatKey, st);
  console.log(`🔗 wecom ${chatKey} → session ${session.id} (agent=${agentId})`);
  return st;
}

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;

/** 分类落盘媒体：图片走网关 images 字段（OCR/视觉链路），文件保留路径给模型 read */
function splitMedia(paths: string[]): { images: string[]; files: string[] } {
  const images: string[] = [];
  const files: string[] = [];
  for (const p of paths) (IMG_EXT.test(p) ? images : files).push(p);
  return { images, files };
}

/** 读图片落盘文件为网关可收的 base64；返回成功项（含源路径，便于只剥离成功上传的提示行） */
async function mediaToImages(imagePaths: string[]): Promise<{ path: string; dataBase64: string; mimeType: string }[]> {
  const fs = await import("node:fs");
  const out: { path: string; dataBase64: string; mimeType: string }[] = [];
  for (const p of imagePaths) {
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > 8 * 1024 * 1024) continue; // 单图上限保护，失败项保留路径提示
      const mime = /\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg";
      out.push({ path: p, dataBase64: buf.toString("base64"), mimeType: mime });
    } catch {}
  }
  return out;
}

/** 去掉已成功上传图片的路径提示行与占位（走 images 字段）；失败图片/文件路径保留——网关同机，模型可 read+OCR */
function refineText(text: string, uploadedPaths: string[], hasImages: boolean): string {
  let t = text;
  for (const p of uploadedPaths)
    t = t.replace(new RegExp(`\n?已保存到 ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（[^\n]*）`), "");
  if (hasImages) t = t.replace(/\n?\[用户发来图片\]/g, "");
  return t.trim();
}

/** 从回复文本中提取 /uploads/ 图片引用（2026-11-10 wecom 出图）：
 * agent 用 show_image 贴的 ![alt](/uploads/xxx.png) → 文件路径；
 * 发送时图先发（media），文本再把已发的图换成纯 alt 行，不重复贴 URL */
const UPLOAD_MD = /!\[([^\]\n]*)\]\(\/(?:uploads\/)?((?:show-)?[\w.-]+\.(?:png|jpe?g|gif|webp|bmp))\)/g;
export function extractImages(reply: string): { files: string[]; cleaned: string } {
  const files: string[] = [];
  const cleaned = reply.replace(UPLOAD_MD, (_m, alt, file) => {
    files.push(path.join(UPLOADS_DIR, file));
    return alt ? `[图: ${alt}]` : "";
  });
  return { files, cleaned };
}

/** tts 工具的投递标记（2026-11-10）：[[audio: /uploads/tts-xxx.mp3]] → 本地路径，
 * 标记行从文本剥离；[[audio_as_voice]] 一并剥离（那是通道指令不是正文） */
const AUDIO_MD = /\[\[audio:\s*\/(?:uploads\/)?([\w.-]+\.mp3)\]\]/g;
export function extractAudio(reply: string): { file: string | null; cleaned: string } {
  let file: string | null = null;
  let cleaned = reply.replace(AUDIO_MD, (_m, f) => {
    if (!file) file = path.join(UPLOADS_DIR, f);
    return "";
  });
  cleaned = cleaned.replace(/\[\[audio_as_voice\]\]\n?/g, "");
  // 标记行整体剥离后不留空行/行首空白
  cleaned = cleaned.replace(/^\s*\n+/g, "").replace(/\n{2,}\s*$/g, "").trimEnd();
  return { file, cleaned };
}

async function main() {
  const config = loadConfig();
  GW_TOKEN = process.env.EASY_AGENT_TOKEN ?? config.gateway?.token ?? "";
  if (!config.wecom?.botId || !config.wecom?.secret) {
    console.error("❌ wecom 未配置：~/.easy-agent/easy-agent.json → wecom.botId / secret");
    process.exit(1);
  }
  // 网关在线等待（2026-11-10 容错）：网关重启窗口内直接退要等 systemd 下一轮，
  // 改为最多等 90s（每 3s 重试）；确实起不来再退出
  {
    const deadline = Date.now() + 90_000;
    let up = false;
    for (;;) {
      try {
        await gwFetch("/health");
        up = true;
        break;
      } catch {
        if (Date.now() >= deadline) break;
        console.log("⏳ 网关未就绪，3s 后重试…");
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!up) {
      console.error("❌ 网关不可达（等待 90s 超时）", GW);
      process.exit(1);
    }
  }

  const defaultAgent = config.wecom.agentId || "default";
  // 按会话固定 agent（配置优先级最高）：key 支持 chatId 或 channel:chatId
  const staticMap = (config.wecom.chatAgents ?? {}) as Record<string, string>;
  const pinnedAgent = (chatKey: string, chatId: string) =>
    staticMap[chatKey] ?? staticMap[chatId] ?? null;

  // 「切换」结果持久化：重启后各会话保持选定的 agent
  const switchFile = path.join(getStateDir(), "wecom-chat-agents.json");
  const manual = new Map<string, string>();
  try {
    const saved = JSON.parse(fs.readFileSync(switchFile, "utf-8"));
    for (const [k, v] of Object.entries(saved)) if (typeof v === "string") manual.set(k, v);
  } catch {}
  const persistSwitches = () => {
    try {
      fs.writeFileSync(switchFile, JSON.stringify(Object.fromEntries(manual), null, 2) + "\n");
    } catch (e: any) {
      console.error("wecom 切换状态持久化失败:", String(e?.message).slice(0, 120));
    }
  };

  const sessions = new Map<string, BridgeState>(); // chatKey → session
  const chatAgents = manual; // 引用同一张表：下面逻辑沿用旧变量名

  const adapter = new WeComAdapter({
    botId: config.wecom.botId,
    secret: config.wecom.secret,
    allowedUserIds:
      process.env.WECOM_ALLOWED_USERS?.split(",").filter(Boolean) ??
      config.wecom.allowedUserIds,
  });

  adapter.onMessage(async (msg) => {
      const chatKey = `${msg.channel}:${msg.chatId}`;
      let reply: string;
      try {
        const pinned = pinnedAgent(chatKey, msg.chatId);
        const agentId = pinned ?? chatAgents.get(chatKey) ?? defaultAgent;
      // 指令：切换 agent（不消耗一次会话轮）
      const sw = /^[\/#]?\s*(切换|switch)\s+(\S+)/i.exec(msg.text);
      if (sw) {
        const want = sw[2];
        if (pinned) {
          reply = `此会话已由配置固定为 ${pinned}，切换指令无效（需修改 easy-agent.json 的 wecom.chatAgents）。`;
        } else {
          const list = (await gwFetch("/api/agents")).agents as Array<{ name: string }>;
          if (!list.some((a) => a.name === want)) {
            reply = `没有 agent「${want}」，可选：${list.map((a) => a.name).join(" / ")}`;
          } else {
            chatAgents.set(chatKey, want);
            persistSwitches();
            await ensureSession(sessions, chatKey, want);
            reply = `已切换到 ${want}，直接说事。（此选择重启后仍保持）`;
          }
        }
        await adapter.sendMessage(msg.chatId, reply);
        return;
      }

      const st = await ensureSession(sessions, chatKey, agentId);
      const mediaPaths = (msg.attachments ?? [])
        .map((a) => (a.url.startsWith("file://") ? a.url.slice(7) : null))
        .filter(Boolean) as string[];
      const { images: imgPaths } = splitMedia(mediaPaths);
      const uploaded = await mediaToImages(imgPaths);
      const images = uploaded.map(({ dataBase64, mimeType }) => ({ dataBase64, mimeType }));
      const text = refineText(msg.text, uploaded.map((u) => u.path), images.length > 0);
      const beforeCount = (await gwFetch(`/api/sessions/${st.sessionId}/messages`)).messages.length;
      const data = await gwFetch(`/api/sessions/${st.sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, images }),
      });
      reply =
        data.status === "queued"
          ? await waitForReply(st.sessionId, beforeCount)
          : String(data.response ?? "(空响应)");
    } catch (e: any) {
      const msgErr = String(e?.message ?? e);
      // 仅会话真没了（404）才清映射重建；409/超时等保留
      if (/\b404\b/.test(msgErr)) sessions.delete(chatKey);
      reply = `⚠️ 处理失败：${msgErr.slice(0, 200)}`;
    }
    try {
      // 图先发（wecom 出图 2026-11-10）：agent 贴的 /uploads/ 图发成 image 消息
      const { files, cleaned: c2 } = extractImages(reply);
      const { file: audio, cleaned } = extractAudio(c2);
      for (const f of files.slice(0, 4)) {
        await adapter.sendImage(msg.chatId, f);
      }
      if (audio) await adapter.sendVoice(msg.chatId, audio);
      if (cleaned.trim()) await adapter.sendMessage(msg.chatId, cleaned);
    } catch (e: any) {
      console.error("wecom 回复发送失败:", String(e?.message).slice(0, 150));
    }
  });

  await adapter.start();
  console.log(
    `🌉 WeCom → 网关桥接就绪 (${GW})，默认 agent=${defaultAgent}` +
      (Object.keys(staticMap).length ? `；固定映射 ${Object.keys(staticMap).length} 条` : "") +
      (manual.size ? `；恢复切换记忆 ${manual.size} 条` : ""),
  );
}

// 直接运行（非被 import）才启动桥接：测试 import 提取函数不触发 main
if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
