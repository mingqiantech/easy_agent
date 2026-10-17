import type { Config } from "./schema.js";

/**
 * 模型引用解析（OpenClaw 方案）
 *
 * ref 支持三种写法：
 *   1. 完整 "provider/model"    → 原样使用
 *   2. alias（models 目录中定义）→ 替换成对应 canonical ref
 *   3. 裸 model id              → 在目录中唯一后缀匹配时补全 provider
 */
export function resolveRef(config: Config, refOrAlias: string): string {
  const catalog = config.models ?? {};

  // 1. alias 精确匹配
  for (const [canonical, entry] of Object.entries(catalog)) {
    if (entry.alias && entry.alias === refOrAlias) return canonical;
  }

  // 2. 已经是 provider/model
  if (refOrAlias.includes("/")) return refOrAlias;

  // 3. 裸 id：目录里唯一后缀匹配
  const matches = Object.keys(catalog).filter(
    (k) => k === refOrAlias || k.endsWith(`/${refOrAlias}`),
  );
  if (matches.length === 1) return matches[0];

  // 无法解析：原样返回（后续 provider 解析会给明确错误）
  return refOrAlias;
}

/**
 * 主模型链：[primary, ...fallbacks]，全部解析为 canonical ref。
 * 未配置 model 时退化为 [defaultModel]（向后兼容）。
 */
export function modelChain(config: Config): string[] {
  const sel = config.model;
  if (!sel) return [resolveRef(config, config.defaultModel)];
  if (typeof sel === "string") return [resolveRef(config, sel)];
  return [sel.primary, ...sel.fallbacks].map((r) => resolveRef(config, r));
}

/**
 * LLMClient 用的故障转移映射：primary ref -> 有序 fallback refs。
 * 链长 <=1 时返回 undefined（无故障转移）。
 */
export function modelFallbackMap(config: Config): Record<string, string[]> | undefined {
  const chain = modelChain(config);
  if (chain.length <= 1) return undefined;
  return { [chain[0]]: chain.slice(1) };
}

/** 视觉模型：alias/ref 解析；未配置时回退主链首位 */
export function resolveVisionModel(config: Config): string {
  if (config.visionModel) return resolveRef(config, config.visionModel);
  return modelChain(config)[0];
}

/** 图片生成模型：解析为去掉 provider 前缀的裸 model id（API body 用）；未配置返回 undefined */
export function resolveImageGenModelId(config: Config): string | undefined {
  if (!config.imageGenModel) return undefined;
  const ref = resolveRef(config, config.imageGenModel);
  const idx = ref.indexOf("/");
  return idx !== -1 ? ref.slice(idx + 1) : ref;
}

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface ResolvedAgent {
  name: string;
  model: string;
  workspaceDir: string;
  description: string;
  thinking: ThinkingLevel;
}

/**
 * 有效思考等级：agent.thinking > thinkingDefault；
 * 若目标模型在目录中明确标记 reasoning:false，自动降级为 off。
 */
function effectiveThinking(
  config: Config,
  modelRef: string,
  override?: string,
): ThinkingLevel {
  const t = ((override as ThinkingLevel | undefined) ??
    config.thinkingDefault ??
    "off") as ThinkingLevel;
  if (t === "off") return "off";
  const entry = config.models?.[modelRef];
  if (entry && entry.reasoning === false) return "off";
  return t;
}

/**
 * 解析全部 Agent（多 Agent 支持，OpenClaw 式）：
 * default 始终存在 = 主模型 + 全局工作区；配置里 agents.* 逐个叠加，
 * model/workspaceDir/thinking 缺省继承 default。
 */
export function resolveAgents(config: Config): ResolvedAgent[] {
  const primary = modelChain(config)[0];
  // default 也可被 agents 节 / agents-state.json（Web UI 持久化）覆盖
  const dflt = (config.agents ?? {})["default"];
  const defaultModel = dflt?.model ? resolveRef(config, dflt.model) : primary;
  const out: ResolvedAgent[] = [
    {
      name: "default",
      model: defaultModel,
      workspaceDir: dflt?.workspaceDir ?? config.workspaceDir,
      description: dflt?.description ?? "默认助手",
      thinking: effectiveThinking(config, defaultModel, dflt?.thinking),
    },
  ];
  for (const [name, a] of Object.entries(config.agents ?? {})) {
    const model = a.model ? resolveRef(config, a.model) : primary;
    out.push({
      name,
      model,
      workspaceDir: a.workspaceDir ?? config.workspaceDir,
      description: a.description ?? name,
      thinking: effectiveThinking(config, model, a.thinking),
    });
  }
  return out;
}
