import type { ModelChannel } from "../protocol/types.js"

export const COMMON_REASONING_EFFORTS = new Set(["low", "medium", "high"] as const)
export const COMMON_REASONING_TARGETS = new Set(["auto", "openai", "deepseek", "claude"] as const)

type ReasoningEffort = "low" | "medium" | "high"
type ReasoningTarget = "auto" | "openai" | "deepseek" | "claude"
type ReasoningChannel = Partial<ModelChannel> & Record<string, unknown>

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
  if (!COMMON_REASONING_EFFORTS.has(effort as ReasoningEffort)) return target === "auto" ? null : { target, effort: "" }
  return { target, effort: effort as ReasoningEffort }
}

/** 根据渠道类型、模型名和地址推断适配器应该使用的推理协议。 */
export function inferReasoningTarget(channel: ReasoningChannel = {}): ReasoningTarget {
  const reasoning = normalizeReasoningConfig(channel.reasoning)
  if (reasoning?.target && reasoning.target !== "auto") return reasoning.target
  if (channel.type === "claude") return "claude"

  const model = cleanString(channel.model).toLowerCase()
  const baseURL = cleanString(channel.baseURL).toLowerCase()
  const provider = channel.provider
  const providerRecord = isRecord(provider) ? provider : {}
  const providerName = cleanString(providerRecord.name || providerRecord.id || provider).toLowerCase()
  const haystack = [model, baseURL, providerName].filter(Boolean).join(" ")

  if (/deepseek|reasoner/.test(haystack)) return "deepseek"
  if (/openai|chatgpt/.test(haystack) || /^gpt-/.test(model) || /^o[1345](?:[-_]|$)/.test(model)) return "openai"
  return "auto"
}

/** 生成供应商特定的 reasoning/thinking 请求片段；不修改传入对象。 */
export function buildReasoningPayload(channel: ReasoningChannel = {}): Record<string, unknown> | null {
  const reasoning = normalizeReasoningConfig(channel.reasoning)
  if (!reasoning?.effort) return null
  const target = inferReasoningTarget({ ...channel, reasoning })
  const adapter = cleanString(channel.type).toLowerCase()
  const openAICompatibleFamily = new Set(["openai-compatible", "qwen", "chatglm"])
  if (target === "claude") {
    if (adapter !== "claude") return null
    return { thinking: { type: "enabled", effort: reasoning.effort } }
  }
  if (target === "deepseek") {
    if (!openAICompatibleFamily.has(adapter)) return null
    return { thinking: { type: "enabled" }, reasoning_effort: reasoning.effort }
  }
  if (target === "openai") {
    if (!openAICompatibleFamily.has(adapter)) return null
    return { reasoning: { effort: reasoning.effort } }
  }
  return null
}

/** 将推理字段合并到请求体，不覆盖已有同类供应商参数。 */
export function applyReasoningPayload(body: Record<string, unknown> = {}, channel: ReasoningChannel = {}): Record<string, unknown> {
  const payload = buildReasoningPayload(channel)
  if (!payload) return body
  const next = { ...body }
  if (isRecord(payload.reasoning)) next.reasoning = { ...(isRecord(next.reasoning) ? next.reasoning : {}), ...payload.reasoning }
  if (isRecord(payload.thinking)) next.thinking = { ...(isRecord(next.thinking) ? next.thinking : {}), ...payload.thinking }
  if (payload.reasoning_effort) next.reasoning_effort = payload.reasoning_effort
  return next
}

/** 用于管理台展示的推理目标/等级摘要。 */
export function describeReasoning(channel: ReasoningChannel = {}): string {
  const reasoning = normalizeReasoningConfig(channel.reasoning)
  if (!reasoning?.effort) return ""
  const target = inferReasoningTarget({ ...channel, reasoning })
  const effortMap: Record<ReasoningEffort, string> = { low: "低", medium: "中", high: "高" }
  const targetMap: Record<ReasoningTarget, string> = { auto: "自动", openai: "OpenAI", deepseek: "DeepSeek", claude: "Claude" }
  return `${targetMap[target] || "自动"} / 推理${effortMap[reasoning.effort] || reasoning.effort}`
}
