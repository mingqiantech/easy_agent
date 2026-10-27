import type { LLMClient } from "@easy-agent/llm/client";
import type { Message } from "@easy-agent/schema/llm";

const MAX_MESSAGES = 50; // 超过这个数触发压缩（可被 EASY_AGENT_COMPACT_MAX_MESSAGES 覆盖）
const KEEP_RECENT = 10; // 保留最近 N 条
// 估算 token 上限。原 8000（≈ 32k chars）在 983k 窗口的模型上过早触发；
// 而压缩＝重写全部历史＝prompt cache 前缀整段作废，频率即成本。
// 旧历史命中缓存后只按 10% 计费，晚压反而省钱；阈值提到 64000 token 等价位。
// 运行时读 env：测试/不同模型可覆盖，改默认值不需改调用方。
function limits() {
  return {
    maxMessages: Number(process.env.EASY_AGENT_COMPACT_MAX_MESSAGES ?? MAX_MESSAGES),
    maxTokens: Number(process.env.EASY_AGENT_COMPACT_MAX_TOKENS ?? 64000),
  };
}

export interface CompactionResult {
  compacted: Message[]; // 压缩后的消息列表
  summary: string; // 压缩摘要
  removed: number; // 移除的消息数
}

/**
 * 检查是否需要压缩
 */
export function needsCompaction(messages: Message[]): boolean {
  const { maxMessages, maxTokens } = limits();
  if (messages.length < maxMessages) return false;
  const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
  return totalChars > maxTokens * 4; // 粗略估算 1 token ≈ 4 chars
}

/** 摘要输入清洗：tool 原始 JSON 不进摘要（小模型消化不了 13k 字符 HTML/结果块），
 * assistant 取 JSON 里的 text + 工具名动作行；每行截 400 字。 */
function digestible(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      // 只保留“执行了什么工具”的动作痕迹，丢参数/结果正文
      try {
        const p = JSON.parse(m.content);
        lines.push(`[tool] 已执行 ${p?.toolName ?? "?"}`);
      } catch {
        lines.push("[tool] 工具结果（已省略）");
      }
      continue;
    }
    let text = String(m.content ?? "").trim();
    if (m.role === "assistant") {
      try {
        const p = JSON.parse(text);
        if (p && typeof p === "object") {
          const names = Array.isArray(p.toolCalls)
            ? p.toolCalls.map((t: any) => t.name).filter(Boolean).join(",")
            : "";
          text = `${String(p.text ?? "").trim()}${names ? `（调用工具：${names}）` : ""}`;
        }
      } catch {}
    }
    if (!text || text.startsWith("【系统恢复】") || text.includes("系统内部指令")) continue;
    lines.push(`[${m.role}]: ${text.slice(0, 400)}`);
  }
  return lines;
}

/** 抽取式兕底：LLM 两次都提不出像样摘要时，用规则拼段落骨架（有损但绝不空壳） */
function extractiveDigest(toCompact: Message[]): string {
  const lines = digestible(toCompact);
  const users = lines.filter((l) => l.startsWith("[user]"));
  const acts = lines.filter((l) => l.startsWith("[tool]") || l.includes("调用工具"));
  const tail = lines.slice(-6);
  const parts: string[] = [];
  if (users.length) parts.push("用户诉求：\n" + users.slice(-5).map((l) => l.replace(/^\[user\]:?\s*/, "- ")).join("\n"));
  if (acts.length) parts.push(`工具动作（${acts.length} 次）：` + [...new Set(acts.map((l) => l.replace(/^\[[^\]]+\]:?\s*/, "")))].slice(-12).join("；"));
  if (tail.length) parts.push("最近对话：\n" + tail.join("\n"));
  return parts.join("\n\n").slice(0, 1600) || "（旧历史无有效文本内容，已折叠）";
}

const SUMMARY_SYSTEM =
  "你是对话摘要助手。将以下对话历史压缩为简洁摘要，用中文，固定三段式：\n" +
  "## 用户诉求\n（目标准确，1-3 行）\n## 已完成/已查明\n（要点列表，保留关键数据/结论/commit 号等硬信息）\n## 待办/下一步\n" +
  "只输出这三段，总长 400 字以内。"

/**
 * 执行压缩
 *
 * 策略：
 * 1. 保留系统消息和最近 KEEP_RECENT 条
 * 2. 中间的消息用 LLM 生成摘要（输入先过 digestible 清洗）
 * 3. 摘要作为新的系统消息
 * 4. 质量闸门：摘要空/过短 → 重试一次 → 仍不行用抽取式兕底，
 *    绝不落“[对话摘要]+空壳”把整段历史换成无效上下文
 *    （2026-10-27 实机：空壳摘要→代理忘掉进度从头重查→烧满 20 步无回复）
 */
export async function compactHistory(
  llm: LLMClient,
  model: string,
  messages: Message[],
): Promise<CompactionResult> {
  // 分离系统消息
  const systemMsgs = messages.filter((m) => m.role === "system");
  const conversation = messages.filter((m) => m.role !== "system");

  if (conversation.length <= KEEP_RECENT) {
    return { compacted: messages, summary: "", removed: 0 };
  }

  // 要压缩的部分
  const toCompact = conversation.slice(0, -KEEP_RECENT);
  const toKeep = conversation.slice(-KEEP_RECENT);

  // 用 LLM 生成摘要（清洗后的可消化文本）
  const cleanLines = digestible(toCompact);
  const compactText = cleanLines.join("\n\n");

  let summary = "";
  for (let attempt = 0; attempt < 2 && summary.length < 20; attempt++) {
    try {
      const response = await llm.generate({
        model,
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", content: compactText }],
        generation: { maxTokens: 1000 },
      });
      const out = String(response.content ?? "").trim();
      // 拒收：空壳、纯标题没正文（只有三段式头没内容）、疑似拄袭模板行
      if (out.length >= 20 && out.replace(/##[^\n]*|\n/g, "").length >= 12)
        summary = out;
    } catch {
      // 落入兕底
    }
  }
  if (!summary) summary = extractiveDigest(toCompact);

  // 构建压缩后的消息列表
  const summaryMessage: Message = {
    role: "system",
    content: `[对话摘要]\n${summary}`,
  };

  return {
    compacted: [...systemMsgs, summaryMessage, ...toKeep],
    summary,
    removed: toCompact.length,
  };
}
