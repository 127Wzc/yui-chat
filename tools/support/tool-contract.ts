import type { JsonValue, ToolOutput } from "../../core/message-chain/types.js"

/** 工具公共契约的 TS 规范；运行时仍由 contract.js 对 unknown 配置做归一化。 */
export const toolSources = ["builtin", "custom", "mcp", "skill", "system"] as const
export type ToolSource = (typeof toolSources)[number]

export const toolDeliveryModes = ["silent", "current-chat", "target-chat", "media"] as const
export type ToolDeliveryMode = (typeof toolDeliveryModes)[number]

export interface ToolAutoDelivery {
  via: "message_send"
  batching: "merge"
  /** 同一批次中任一工具开启时，全部投递完成后统一续答一次。 */
  continueConversation: boolean
}

export const toolExecutionEffects = ["read", "idempotent_write", "non_idempotent", "destructive", "unknown"] as const
export type ToolExecutionEffect = (typeof toolExecutionEffects)[number]

export const toolRepeatPolicies = ["allow", "bounded", "dedupe", "explicit_only"] as const
export type ToolRepeatPolicy = (typeof toolRepeatPolicies)[number]

export const toolRetryPolicies = ["safe", "executor", "no_ambiguous_retry", "none"] as const
export type ToolRetryPolicy = (typeof toolRetryPolicies)[number]

/**
 * 何时把一次调用标记为"已派发"（此后不再重试）。
 *
 * `immediate` 在进入执行边界时立即标记，适用于绝大多数副作用工具。
 * `deferred` 让工具自己在真正把请求交给宿主前调用 markDispatched，
 * 这样纯参数错误不会被误判为"已经发生过副作用"而失去一次纠正机会。
 */
export const toolDispatchMarkings = ["immediate", "deferred"] as const
export type ToolDispatchMarking = (typeof toolDispatchMarkings)[number]

/** 工具级权限声明；具体角色判断仍由 access/policy 层负责。 */
export interface ToolPolicy {
  requiresMaster?: boolean
  requiresGroupAdmin?: boolean
  [key: string]: JsonValue | undefined
}

/** 描述工具执行次数、副作用、重试和并行边界的公共策略。 */
export interface ToolExecutionPolicy {
  effect: ToolExecutionEffect
  repeatPolicy: ToolRepeatPolicy
  retryPolicy: ToolRetryPolicy
  dispatchMarking: ToolDispatchMarking
  supportsCount: boolean
  countField: string
  maxCount: number
  targetFields: string[]
  operationFields: string[]
  maxAttempts: number
  timeoutMs: number
  background: boolean
  parallelSafe: boolean
  operationFamily: string
  polling: boolean
  maxPolls: number
  minPollIntervalMs: number
  promptCount: {
    keywords: string[]
    units: string[]
    maxClauses: number
  } | null
}

/** Builtin、Custom 和 MCP 共用的工具元数据，不包含具体执行实现。 */
export interface ToolCommon {
  displayNameZh?: string
  description?: string
  descriptionZh?: string
  parameters: Record<string, JsonValue>
  configSchema?: Record<string, JsonValue>
  source: ToolSource
  category: string
  categoryLabel?: string
  risk?: string
  tags: string[]
  /** Responses tool_search 可延迟加载此函数定义；Chat Completions 忽略该字段。 */
  deferLoading: boolean
  delivery: ToolDeliveryMode
  /** 未声明时不接管工具结果；仅显式集成的工具可生成自动投递计划。 */
  autoDelivery: ToolAutoDelivery | null
  /** 默认 true；仅明确声明后台/即时动作的工具才可以关闭最终模型回复。 */
  requiresFinalReply: boolean
  hiddenFromModel?: boolean
  execution: ToolExecutionPolicy
  executionByAction: Record<string, ToolExecutionPolicy>
  policy: ToolPolicy
  provenance: Record<string, JsonValue>
  pipeline?: Record<string, JsonValue> | null
}

/** 工具执行时由运行时注入的取消、账本和可观测性上下文。 */
export interface ToolExecutionContext {
  signal?: AbortSignal
  agent?: {
    signal?: AbortSignal
    [key: string]: unknown
  }
  execution?: {
    markDispatched?: () => unknown
    background?: boolean
    operationId?: string
    [key: string]: unknown
  }
  observability?: Record<string, unknown>
  [key: string]: unknown
}

/** 模型可见工具的最小描述；动态 Custom 工具的未知字段保留在扩展边界。 */
export interface ToolDefinition {
  name: string
  common?: ToolCommon
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<unknown> | unknown
  [key: string]: unknown
}

export type ToolExecutor = (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<unknown> | unknown
export type NormalizedToolResult = ToolOutput | Record<string, unknown> | string
