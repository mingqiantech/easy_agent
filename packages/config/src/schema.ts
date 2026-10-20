import { z } from "zod";

/**
 * 模型配置采用 OpenClaw 方案：
 * - models: 模型目录，key 为 "provider/model-id"，可配 alias 短名
 * - model:  主模型 + 有序 fallback 链（字符串或 {primary, fallbacks} 对象）
 * 旧字段 defaultModel / visionModel 保留且向后兼容（model 存在时优先）。
 */

export const ModelSelectionSchema = z.union([
  z.string(),
  z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).default([]),
  }),
]);
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const CatalogEntrySchema = z.object({
  /** 短名，可在 model/visionModel 等处直接引用 */
  alias: z.string().optional(),
  /** 能力标记（供选模型时参考） */
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  /** 是否支持深度思考（false 时 agent 的 thinking 自动降级为 off） */
  reasoning: z.boolean().optional(),
  /** 元信息（对齐 openclaw 模型目录；暂只存不消费） */
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  name: z.string().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const ThinkingEnum = z.enum(["off", "low", "medium", "high"]);
export type ThinkingLevel = z.infer<typeof ThinkingEnum>;

export const ConfigSchema = z.object({
  defaultModel: z.string().default("openai/qwen3.8-flash"),
  /** 全局思考等级默认值（各 agent 可用 thinking 覆盖） */
  thinkingDefault: ThinkingEnum.default("off"),
  /** 模型目录："provider/model" -> { alias?, ... } */
  models: z.record(CatalogEntrySchema).default({}),
  /** 主模型选择（优先于 defaultModel）；ref 或 alias，支持 fallbacks 链 */
  model: ModelSelectionSchema.optional(),
  providers: z
    .record(z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional(), api: z.string().optional() }))
    .default({}),
  /** 网页搜索：填了哪个 key 用哪个 API（auto 优先级 tavily>brave>bocha），都没填回退 Bing 抓取 */
  websearch: z
    .object({
      provider: z.enum(["auto", "tavily", "brave", "bocha", "bing"]).default("auto"),
      tavilyApiKey: z.string().optional(),
      braveApiKey: z.string().optional(),
      bochaApiKey: z.string().optional(),
    })
    .default({ provider: "auto" }),
  /** 记忆检索：向量/混合检索配置。embedding.provider=simple 零依赖离线可用；
   * ollama/openai 接真模型；hybrid.enabled=false 退回纯关键词 */
  memorySearch: z
    .object({
      embedding: z
        .object({
          provider: z.enum(["simple", "ollama", "openai"]).default("simple"),
          /** ollama/openai 的 API 地址 */
          baseUrl: z.string().optional(),
          apiKey: z.string().optional(),
          /** nomic-embed-text / bge-m3 / text-embedding-3-small 等 */
          model: z.string().optional(),
        })
        .default({ provider: "simple" }),
      hybrid: z
        .object({
          enabled: z.boolean().default(true),
          vectorWeight: z.number().min(0).max(1).default(0.7),
          textWeight: z.number().min(0).max(1).default(0.3),
        })
        .default({ enabled: true, vectorWeight: 0.7, textWeight: 0.3 }),
      /** 重索引周期（分钟）：内容 hash 未变时近乎零成本 */
      reindexIntervalMinutes: z.number().int().min(1).default(10),
    })
    .default({
      embedding: { provider: "simple" },
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      reindexIntervalMinutes: 10,
    }),
  stateDir: z.string().default(""),
  workspaceDir: z.string().default("."),
  // Week 6: 渠道配置（可选）
  telegram: z
    .object({
      botToken: z.string().default(""),
      allowedUserIds: z.array(z.number()).default([]),
    })
    .optional(),
  discord: z
    .object({
      botToken: z.string().default(""),
      applicationId: z.string().default(""),
      allowedUserIds: z.array(z.string()).default([]),
    })
    .optional(),
  /** 多 Agent 定义："名字" -> { model?, workspaceDir?, description?, thinking? } */
  agents: z
    .record(
      z.object({
        description: z.string().optional(),
        model: z.string().optional(),
        workspaceDir: z.string().optional(),
        /** 该 agent 的思考等级；缺省继承 thinkingDefault */
        thinking: ThinkingEnum.optional(),
      }),
    )
    .default({}),
  /** 视觉模型（ref 或 alias）；未配置时用主模型链首位 */
  visionModel: z.string().optional(),
  /** 工具裁剪：disable 列表里的内置工具不注册（如 ["image-gen","sub_agent"]） */
  tools: z
    .object({ disable: z.array(z.string()).default([]) })
    .default({ disable: [] }),
  /** 图片生成模型（ref 或 alias） */
  imageGenModel: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
