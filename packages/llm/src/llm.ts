import { z } from "zod";
import { Message, ToolCall, ToolDefinition } from "./message.js";

/**
 * 生成选项（控制模型输出行为）
 */

export const GenerationOptions = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  topP: z.number().min(0).max(1).optional(),
  stopSequences: z.array(z.string()).optional(),
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
});

export type LLMRequest = z.infer<typeof LLMRequest>;
/**
 * Token 使用量
 */
export const Usage = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
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

export type LLMStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; input: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string }
  | { type: "error"; error: string };

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
