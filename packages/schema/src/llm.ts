import { z } from "zod";
import { Message } from "./message.js";
import { ToolCall, ToolDefinition } from "./tool.js";

export { Message, ToolCall, ToolDefinition };

/**
 * 生成选项（控制模型输出行为）
 */
export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const GenerationOptions = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  stopSequences: z.array(z.string()).optional(),
  /** 思考等级（对齐 OpenClaw thinking）：off 不发送；openai 系走 reasoning_effort，anthropic 走 thinking.budget_tokens */
  thinking: ThinkingLevelSchema.optional(),
});
export type GenerationOptions = z.infer<typeof GenerationOptions>;

/**
 * LLM 请求（发给模型的完整数据包）
 */
export const LLMRequest = z.object({
  model: z.string(),
  system: z.string().optional(),
  messages: z.array(Message),
  tools: z.array(ToolDefinition).optional(),
  toolChoice: z.enum(["none", "auto", "manual"]).optional(),
  generation: GenerationOptions.optional(),
  /** 中断信号：透传给 provider（ai-sdk abortSignal），任意步终止请求 */
  signal: z.custom<AbortSignal>().optional(),
});
export type LLMRequest = z.infer<typeof LLMRequest>;

/**
 * Token 使用量
 */
export const Usage = z.object({
  /** 总输入 tokens（含缓存部分，与厂商计费口径对齐） */
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  /** 命中缓存读回的输入 tokens（⊆ promptTokens） */
  cacheReadTokens: z.number().optional(),
  /** 写入缓存的输入 tokens（Anthropic cache_creation，⊆ promptTokens） */
  cacheWriteTokens: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

/**
 * LLM 响应（模型返回的完整结果）
 */
export const LLMResponse = z.object({
  content: z.string(),
  toolCalls: z.array(ToolCall).optional(),
  usage: Usage,
  finishReason: z.enum(["stop", "length", "tool_calls", "error"]).optional(),
});
export type LLMResponse = z.infer<typeof LLMResponse>;

/**
 * 流式事件
 */
export type LLMStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; input: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string }
  | { type: "error"; error: string };

/**
 * 模型元信息
 */
export const ModelInfo = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  contextWindow: z.number(),
  maxOutputTokens: z.number().optional(),
  supportsTools: z.boolean().default(true),
  supportsVision: z.boolean().default(false),
  inputCostPerMToken: z.number().optional(),
  outputCostPerMToken: z.number().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;
