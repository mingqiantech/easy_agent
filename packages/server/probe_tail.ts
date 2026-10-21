/**
 * 尾断点（滚动前缀缓存）验证探针：走真实 AnthropicProvider 代码路径。
 * 模拟 agent tool loop 连续 3 次调用，历史纯追加、末条盖断点：
 *   A 第1轮：system+长user      → 期望 cache_write（首次建缓存）
 *   B 第2轮：A + assistant+tool → 期望 cache_read 覆盖前缀，仅新尾巴写入
 *   C 隔 6 分钟重复 B → 观察网关 5m TTL 过期后行为（外部限制）
 * 运行：bun packages/server/probe_tail.ts [--with-ttl-gap]
 */
import fs from "node:fs";
import { loadConfig } from "@easy-agent/config/loader";
import { AnthropicProvider } from "@easy-agent/llm/providers/anthropic.js";
import type { Message } from "@easy-agent/schema/llm";

const config = loadConfig();
const prov = (config.providers as any)["qwencloud-token-plan"];
const provider = new AnthropicProvider({ apiKey: prov.apiKey, baseUrl: prov.baseUrl });

const pad = (s: string, n: number) => s + "上下文填充片段，用于把历史推到最小可缓存前缀以上。".repeat(n);
const longSys = "你是缓存探针助手，保持简洁。" + "规则条款编号递增，请勿改动前缀。".repeat(200);

const base: Message[] = [
  { role: "user", content: pad("任务：分析这段长文本的要点。", 120) },
];
const turn2: Message[] = [
  ...base,
  { role: "assistant", content: JSON.stringify({ text: "要点1/2/3", toolCalls: [{ id: "tc1", name: "lookup", input: { q: "x" } }] }) },
  { role: "tool", content: JSON.stringify({ toolCallId: "tc1", toolName: "lookup", result: pad("查询结果。", 120) }) },
];

async function call(tag: string, messages: Message[]) {
  const res = await provider.generate({
    model: "qwen3.8-flash",
    messages,
    system: longSys, // 走 systemMessages 断点路径（与真实 agent 一致）
    maxTokens: 16,
  } as any);
  const u = res.usage;
  const line = `${tag} prompt=${u.promptTokens} read=${u.cacheReadTokens ?? 0} write=${u.cacheWriteTokens ?? 0} uncached=${u.promptTokens - (u.cacheReadTokens ?? 0) - (u.cacheWriteTokens ?? 0)}`;
  console.log(line);
  fs.appendFileSync("/tmp/tail_probe.log", line + "\n");
}

await call("[A 建缓存]", base);
await call("[B 追加轮]", turn2);
await call("[C 同前缀再问]", [...turn2, { role: "user", content: "继续" } as Message]);
