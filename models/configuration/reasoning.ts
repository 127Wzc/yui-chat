import type { ModelChannel } from "../protocol/types.js"

export const REASONING_PROFILES = {
  openai: { efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  deepseek: { efforts: ["none", "low", "high", "max"], defaultEffort: "high" },
  claude: { efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
} as const

type ReasoningTarget = "auto" | keyof typeof REASONING_PROFILES
type ReasoningEffort = typeof REASONING_PROFILES[keyof typeof REASONING_PROFILES]["efforts"][number]
type ReasoningChannel = Partial<ModelChannel> & Record<string, unknown>
export const COMMON_REASONING_TARGETS: ReadonlySet<string> = new Set(["auto", ...Object.keys(REASONING_PROFILES)])
const allEfforts: ReadonlySet<string> = new Set(Object.values(REASONING_PROFILES).flatMap(profile => [...profile.efforts]))

export interface ReasoningConfig {
  target: ReasoningTarget
  effort: ReasoningEffort | ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function cleanString(value: unknown): string {
  return String(value || "").trim()
}

/** 将管理配置中的推理目标和等级收敛为供应商无关结构。 */
export function normalizeReasoningConfig(input: unknown = {}): ReasoningConfig | null {
  if (!isRecord(input)) return null
  const effort = cleanString(input.effort || input.level).toLowerCase()
  const targetRaw = cleanString(input.target || input.vendor || input.provider).toLowerCase()
  const target: ReasoningTarget = COMMON_REASONING_TARGETS.has(targetRaw as ReasoningTarget) ? targetRaw as ReasoningTarget : "auto"
  if (!allEfforts.has(effort)) return target === "auto" ? null : { target, effort: "" }
  return { target, effort: effort as ReasoningEffort }
}

/** 根据渠道类型、模型名和地址推断适配器应该使用的推理协议。 */
export function inferReasoningTarget(channel: ReasoningChannel = {}): ReasoningTarget {
  const reasoning = normalizeReasoningConfig(channel.reasoning)
  if (reasoning?.target && reasoning.target !== "auto") return reasoning.target

  const model = cleanString(channel.model).toLowerCase()
  const baseURL = cleanString(channel.baseURL).toLowerCase()
  const provider = channel.provider
  const providerRecord = isRecord(provider) ? provider : {}
  const providerName = cleanString(providerRecord.name || providerRecord.id || provider).toLowerCase()
  const haystack = [model, baseURL, providerName].filter(Boolean).join(" ")

  if (/deepseek|reasoner/.test(haystack)) return "deepseek"
  if (channel.type === "claude" || /claude|anthropic/.test(haystack)) return "claude"
  if (/openai|chatgpt/.test(haystack) || /^gpt-/.test(model) || /^o[1345](?:[-_]|$)/.test(model)) return "openai"
  return "auto"
}

/** 编辑器和配置校验共用的协议能力；不返回渠道凭证。 */
export function getReasoningOptions(channel: ReasoningChannel = {}) {
  const target = inferReasoningTarget(channel)
  const adapter = cleanString(channel.type).toLowerCase()
  const compatible = target === "claude" ? adapter === "claude"
    : target !== "auto" && ["openai-compatible", "openai-responses", "qwen", "chatglm", ...(target === "deepseek" ? ["claude"] : [])].includes(adapter)
  const profile = target === "auto" ? null : REASONING_PROFILES[target]
  return { target, efforts: compatible && profile ? [...profile.efforts] : [], defaultEffort: compatible && profile ? profile.defaultEffort : "" }
}

/** 仅升级持久化旧配置；请求发送和新配置校验不接受等级别名。 */
export function migrateStoredReasoning(config: unknown): void {
  if (!isRecord(config)) return
  const providers = Array.isArray(config.apiProviders) ? config.apiProviders.filter(isRecord) : []
  for (const model of Array.isArray(config.models) ? config.models : []) {
    if (!isRecord(model) || !isRecord(model.reasoning)) continue
    const provider = providers.find(item => item.name === model.apiProvider) || {}
    const channel = { type: cleanString(model.adapter || provider.type), model: cleanString(model.modelIdentifier || model.model || model.name), baseURL: cleanString(model.baseURL || provider.baseURL), provider, reasoning: model.reasoning }
    const options = getReasoningOptions(channel)
    if (options.target === "deepseek" && model.reasoning.effort === "medium" && options.efforts.length) model.reasoning.effort = "high"
    // 旧版在未知目标或不兼容协议下忽略等级；升级为显式 default，保持原请求行为。
    else if (["low", "medium", "high"].includes(cleanString(model.reasoning.effort)) && !options.efforts.length) model.reasoning.effort = ""
  }
}

/** 生成供应商特定的 reasoning/thinking 请求片段；不修改传入对象。 */
export function buildReasoningPayload(channel: ReasoningChannel = {}): Record<string, unknown> | null {
  const reasoning = normalizeReasoningConfig(channel.reasoning)
  if (!reasoning?.effort) return null
  const target = inferReasoningTarget({ ...channel, reasoning })
  if (!(getReasoningOptions(channel).efforts as readonly string[]).includes(reasoning.effort)) throw new Error(`推理配置无效：${target} / ${reasoning.effort}，请检查适配目标和对话协议`)
  const adapter = cleanString(channel.type).toLowerCase()
  if (target === "claude") return { thinking: { type: "adaptive" }, output_config: { effort: reasoning.effort } }
  if (target === "deepseek" && adapter === "claude") {
    return reasoning.effort === "none" ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, output_config: { effort: reasoning.effort } }
  }
  if (adapter === "openai-responses") return { reasoning: { effort: reasoning.effort } }
  return {
    ...(target === "deepseek" ? { thinking: { type: reasoning.effort === "none" ? "disabled" : "enabled" } } : {}),
    reasoning_effort: reasoning.effort,
  }
}

/** 将推理字段合并到请求体，不覆盖已有同类供应商参数。 */
export function applyReasoningPayload(body: Record<string, unknown> = {}, channel: ReasoningChannel = {}): Record<string, unknown> {
  const payload = buildReasoningPayload(channel)
  if (!payload) return body
  const next = { ...body }
  if (isRecord(payload.reasoning)) next.reasoning = { ...(isRecord(next.reasoning) ? next.reasoning : {}), ...payload.reasoning }
  if (isRecord(payload.thinking)) next.thinking = { ...(isRecord(next.thinking) ? next.thinking : {}), ...payload.thinking }
  if (isRecord(payload.output_config)) next.output_config = { ...(isRecord(next.output_config) ? next.output_config : {}), ...payload.output_config }
  if (payload.reasoning_effort) next.reasoning_effort = payload.reasoning_effort
  return next
}

/** 用于管理台展示的推理目标/等级摘要。 */
export function describeReasoning(channel: ReasoningChannel = {}): string {
  const reasoning = normalizeReasoningConfig(channel.reasoning)
  if (!reasoning?.effort) return ""
  const target = inferReasoningTarget({ ...channel, reasoning })
  const targetMap: Record<ReasoningTarget, string> = { auto: "auto", openai: "OpenAI", deepseek: "DeepSeek", claude: "Claude" }
  return `${targetMap[target] || "auto"} / ${reasoning.effort}`
}
