/**
 * 模型计费表（USD / 百万 token）——全仓唯一真源。
 * providers 的 listModels 引用这里；token_usage 落库时用 estimateCostUsd 算行级成本。
 *
 * 缓存段计费系数（Anthropic 显式缓存语义，qwencloud 网关同口径）：
 * - cache_read  = 基础输入价 × 0.1
 * - cache_write = 基础输入价 × 1.25（5m TTL；1h TTL 为 2x，本网关被降级为 5m）
 * OpenAI/兼容网关的隐式缓存无 write 段，天然只算 read×0.1，兼容。
 */
export interface ModelPrice {
  input: number; // USD / 1M prompt tokens（未缓存段）
  output: number; // USD / 1M completion tokens
}

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25;

/** key = 模型短名（不含 provider/ 前缀）；查价时先全名再短名 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "qwen3.8-flash": { input: 2.5, output: 10 },
  "qwen3.8-max": { input: 2, output: 8 },
  "glm-5.3": { input: 0.15, output: 0.6 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  // openrouter 全名 key（其 id 自带 org/ 前缀）
  "anthropic/claude-sonnet-4": { input: 3, output: 15 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "google/gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "meta-llama/llama-3.1-70b-instruct": { input: 0.52, output: 1.26 },
};

/** ollama 本地模型免费：查不到价时按 0 处理由调用方决定，这里返回 undefined */
export function priceFor(model: string): ModelPrice | undefined {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const short = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  if (MODEL_PRICES[short]) return MODEL_PRICES[short];
  // openrouter 风格："openrouter/anthropic/claude-sonnet-4" → 去掉首段再查
  const first = model.indexOf("/");
  if (first > 0 && MODEL_PRICES[model.slice(first + 1)]) return MODEL_PRICES[model.slice(first + 1)];
  return undefined;
}

export interface UsageLike {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * 单次调用成本（USD）。定价缺失返回 undefined（UI/统计按 null 展示，不冒充 0 成本）。
 * 不变式：promptTokens = 未缓存 + read + write（全仓口径，见 anthropic.ts 归一注释）。
 */
export function estimateCostUsd(model: string, u: UsageLike): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const prompt = Math.max(0, u.promptTokens ?? 0);
  const read = Math.min(prompt, Math.max(0, u.cacheReadTokens ?? 0));
  const write = Math.min(prompt - read, Math.max(0, u.cacheWriteTokens ?? 0));
  const uncached = prompt - read - write;
  const out = Math.max(0, u.completionTokens ?? 0);
  const cost =
    (uncached * p.input + read * p.input * CACHE_READ_MULT + write * p.input * CACHE_WRITE_MULT + out * p.output) /
    1e6;
  return Math.round(cost * 1e6) / 1e6; // 微美元精度，避免浮点尾巴
}
