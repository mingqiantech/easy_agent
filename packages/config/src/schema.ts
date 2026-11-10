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
      // ollama 档为代码已支持的后端（本地代理/云），schema 曾遗漏枚举（2026-10-31 显式配置时发现）
      provider: z.enum(["auto", "tavily", "brave", "bocha", "ollama", "bing"]).default("auto"),
      tavilyApiKey: z.string().optional(),
      braveApiKey: z.string().optional(),
      bochaApiKey: z.string().optional(),
      /** 缺省自动复用 providers.ollama.baseUrl */
      ollamaBaseUrl: z.string().optional(),
      /** 仅直连 ollama.com 云时需要 */
      ollamaApiKey: z.string().optional(),
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
      /** 精排：MMR 去冗余 + 时间衰减（对齐 OpenClaw rerank 层） */
      rerank: z
        .object({
          mmr: z.boolean().default(true),
          lambda: z.number().min(0).max(1).default(0.7),
          /** 半衰期天数；0=关 */
          halfLifeDays: z.number().min(0).default(0),
        })
        .default({ mmr: true, lambda: 0.7, halfLifeDays: 0 }),
      /** 重索引周期（分钟）：内容 hash 未变时近乎零成本 */
      reindexIntervalMinutes: z.number().int().min(1).default(10),
    })
    .default({
      embedding: { provider: "simple" },
      hybrid: { enabled: true, vectorWeight: 0.7, textWeight: 0.3 },
      rerank: { mmr: true, lambda: 0.7, halfLifeDays: 0 },
      reindexIntervalMinutes: 10,
    }),
  stateDir: z.string().default(""),
  /** 实际加载的配置文件路径（loadConfig 写入，非用户配置项）：
   *  PATCH /api/agents 直接回写此文件（2026-10-31 废掉 agents-state.json 双层结构） */
  configPath: z.string().optional(),
  workspaceDir: z.string().default("."),
  /** Dreaming 参数覆盖（缺省用 packages/memory/src/dreaming.ts DEFAULT_DREAMING_CONFIG）；
   * env EASY_AGENT_DREAM_* 优先级更高 */
  dreaming: z
    .object({
      halfLifeDays: z.number().min(1).optional(),
      reviewIntervals: z.array(z.number().min(1)).optional(),
      reviewQueueMax: z.number().int().min(1).optional(),
      themeWindowDays: z.number().min(1).optional(),
      forgetDays: z.number().min(0).optional(),
      dormancyScoreFloor: z.number().min(0).max(1).optional(),
      lightMaxMsgs: z.number().int().min(10).optional(),
      memoryBudgetChars: z.number().int().min(2000).optional(),
      distillAgeDays: z.number().min(1).optional(),
      distillEnabled: z.boolean().optional(),
      l2MergeThresholdChars: z.number().int().min(4000).optional(),
    })
    .optional(),
  /** 会话组织策略（2026-11-02 elf 拍板：全塞一条会话滚动，归档阈值 60 天）：
   * 每个 agent 主入口固定用置顶首页会话（UI 不再提供新建入口）；
   * 超过 archiveDays 的旧消息移入 messages_archive（UI 全量历史仍可见，LLM 上下文自动变轻）；
   * 超过 archiveDays 未更新的非置顶会话整场标 archived（列表隐藏，搜索/历史不丢）。
   * env EASY_AGENT_ARCHIVE_DAYS 覆盖（0=关闭时间归档） */
  sessions: z
    .object({
      archiveDays: z.number().int().min(1).default(60),
      /** 绝对不动的最近消息条数（防罕见场景把会话掏空；与压缩保留段同量级） */
      keepRecent: z.number().int().min(2).default(10),
    })
    .default({ archiveDays: 60, keepRecent: 10 }),
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
  /** 企业微信智能机器人（@wecom/aibot-node-sdk 长连接，无需公网回调） */
  wecom: z
    .object({
      botId: z.string().default(""),
      secret: z.string().default(""),
      /** 白名单 userid；空 = 放行全部 */
      allowedUserIds: z.array(z.string()).default([]),
      /** 默认接入的网关 agent（会话内可用「切换 <name>」改） */
      agentId: z.string().default("default"),
      /** 按会话固定 agent（2026-10-31）：key=chatId 或 channel:chatId，value=agent 名；
       *  优先级最高，固定后「切换」指令对该会话无效 */
      chatAgents: z.record(z.string()).default({}),
    })
    .optional(),
  /** 多 Agent 定义："名字" -> { model?, workspaceDir?, description?, thinking?, tools? } */
  agents: z
    .record(
      z.object({
        description: z.string().optional(),
        model: z.string().optional(),
        workspaceDir: z.string().optional(),
        /** 该 agent 的思考等级；缺省继承 thinkingDefault */
        thinking: ThinkingEnum.optional(),
        /** agent 专属工具裁剪（全局 tools.disable 之外再减一层，如禁用 trae_agent） */
        tools: z
          .object({ disable: z.array(z.string()).default([]) })
          .optional(),
        /** 附加提示词（2026-11-02 由 toolHint 改名；行为守则类内容请写各 agent 工作区
         *  AGENTS.md，本字段只留给“随工具开关变化/需频繁拨弄”的 per-request 注入策略）：
         *  每轮动态注入 system 区（开关切换即时生效，不落库不动 prompt 前缀缓存）；
         *  与内置 trae 使用引导叠加，自定义文案优先 */
        extraPrompt: z.string().max(2000).optional(),
        /** @deprecated 旧名，加载时自动升级为 extraPrompt（两者都在时 extraPrompt 优先） */
        toolHint: z.string().max(2000).optional(),
        /** 关联 agent（2026-10-30）：memory_search 主检索命中后用索引词二查
         *  这些 agent 的工作区知识（典型：新隔离 agent 关联 default 拿历史记忆） */
        relatedAgents: z.array(z.string()).optional(),
        /** 监视的 agent（2026-10-31）：拓扑图画 watch 边；每轮 system 注入监视引导，
         *  提醒它用 agent_status 工具巡检对方在跑什么（"*"=全部其他 agent） */
        watchAgents: z.array(z.string()).optional(),
      }),
    )
    .default({}),
  /** ACP 长会话 agent（acp_agent 工具）：agents 非空才注册 */
  acp: z
    .object({
      timeoutMinutes: z.number().positive().max(60).optional(),
      idleMinutes: z.number().positive().optional(),
      autoApprove: z.boolean().optional(),
      allowedWorkdirs: z.array(z.string()).optional(),
      maxSessionsPerAgent: z.number().int().positive().optional(),
      agents: z
        .record(z.object({ bin: z.string(), args: z.array(z.string()).optional(), cwd: z.string().optional() }))
        .default({}),
    })
    .default({ agents: {} }),
  /** 视觉模型（ref 或 alias）；未配置时用主模型链首位 */
  visionModel: z.string().optional(),
  /** 工具裁剪：disable 列表里的内置工具不注册（如 ["image-gen","sub_agent"]） */
  tools: z
    .object({ disable: z.array(z.string()).default([]) })
    .default({ disable: [] }),
  /** 外部编码 agent（trae-cli）：trae_agent 工具配置；enabled=false 或缺省节均不注册 */
  trae: z
    .object({
      enabled: z.boolean().default(true),
      bin: z.string().optional(),
      timeoutMinutes: z.number().positive().max(60).optional(),
      allowedWorkdirs: z.array(z.string()).optional(),
      extraArgs: z.array(z.string()).optional(),
      /** ⚠️ 绕过 trae 工具审批；仅信任环境手动开启 */
      yolo: z.boolean().optional(),
      permissionMode: z.enum(["default", "plan", "bypass_permissions"]).optional(),
      allowedTools: z.array(z.string()).optional(),
    })
    .optional(),
  /** 图片生成模型（ref 或 alias） */
  imageGenModel: z.string().optional(),
  /** 网关访问控制（2026-11-10 elf 点单"增加密钥类"）：网关监听全网卡（WSL2 NAT 下
   * Windows 浏览器靠本机 IP 访它，环回绑死会断），局域网共享必须配这把 token：
   * Bearer 头或 ea_token cookie 任一匹配才放行（/health 豁免免监控误报）；
   * 未配 = 不鉴权（启动日志会⚠️提醒）。设置：ea-config auth token <密钥> */
  gateway: z
    .object({
      token: z
        .string()
        .min(6)
        .max(128)
        .regex(/^[\w.-]+$/, "token 只允许字母数字 . - _")
        .optional(),
    })
    .optional(),
  /** 语音合成（2026-11-10 elf 点单）：OpenAI 兼容 /audio/speech 接口（Ark/DashScope 兼容模式等）。
   * apiKey 支持 ${ENV_VAR} 引用（复用 providers 同款插值：loader 只处理 providers，
   * tts 节插值在接线处做）；不配或空→tts 工具不注册，零开销 */
  tts: z
    .object({
      apiKey: z.string().default(""),
      /** 缺省 https://api.openai.com/v1 */
      baseUrl: z.string().optional(),
      /** tts-1 / cosyvoice-v1(兼容模式) 等，缺省 tts-1 */
      model: z.string().optional(),
      /** alloy / 中文厂商音色名 */
      voice: z.string().optional(),
      speed: z.number().min(0.25).max(4).optional(),
    })
    .optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
