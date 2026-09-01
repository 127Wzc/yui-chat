import { createHash } from "node:crypto"
import {
  getToolCommon,
  resolveToolExecutionPolicy,
  toolExecutionEffects,
  toolRepeatPolicies,
  toolRetryPolicies,
} from "./contract.js"
import type { ToolExecutionPolicy } from "./tool-contract.js"
import type { ToolOutput } from "../../core/message-chain/types.js"
import { serializeToolOutput, summarizeToolOutput } from "../../core/message-chain/serialize.js"

type UnknownRecord = Record<string, unknown>
type OperationStatus = "pending" | "queued" | "partial" | "success" | "ambiguous" | "failed" | "denied" | "canceled"
type RuntimePhase = "tools" | "finalizing"
type GuardDecisionKind = "allow" | "rewrite" | "skip" | "finalize"

interface ExecutionConfig {
  toolTimeoutMs?: unknown
  maxToolCalls?: unknown
  maxSideEffectCalls?: unknown
  maxConsecutiveGuardBlocks?: unknown
  maxNoProgress?: unknown
  defaultMaxAttempts?: unknown
}

interface ExecutionState {
  runId: string
  userTurnId: string
  scope: string
  turnCount: number
  toolCallCount: number
  sideEffectCount: number
  guardBlockStreak: number
  noProgressStreak: number
  pollDelayMs: number
  phase: RuntimePhase
  finalizationReason: string
  maxTurns: number
  maxToolCalls: number
  maxSideEffectCalls: number
  maxConsecutiveGuardBlocks: number
  maxNoProgress: number
  defaultMaxAttempts: number
}

interface ExecutionOperation {
  id: string
  key: string
  family: string
  targetKey: string
  tool: string
  requestedTotal: number
  completedTotal: number
  remaining: number
  status: OperationStatus
  attempts: number
  polls: number
  lastResultFingerprint: string
  context: { source: string; purpose: string }
}

interface OperationProgress {
  operationId: string
  targetKey: string
  requestedTotal: number
  completedTotal: number
  remaining: number
}

interface GuardResult {
  decision: GuardDecisionKind
  code: string
  message?: string
  args?: UnknownRecord
  policy: { execution: ToolExecutionPolicy }
  operations: ExecutionOperation[]
  signature: string
  plannedCount?: number
  round?: number
}

interface NormalizedToolResult {
  content: unknown
  status: string
  executedCount: number
  targetCounts: Record<string, unknown>
  retryAllowed: boolean
  structured: boolean
  dispatched: boolean
  metadata: unknown
}

interface ToolExecutionResult extends NormalizedToolResult {
  value?: unknown
  attempt: number
  timedOut?: boolean
  error?: unknown
}

interface LedgerEntry {
  runId: string
  userTurnId: string
  operationId: string
  operationIds: string[]
  toolUseId: string
  tool: string
  normalizedArgs: unknown
  targetKeys: string[]
  requestedCount: number
  executedCount: number
  completedCount: number
  remainingCount: number
  attempt: number
  status: string
  decision: GuardDecisionKind
  guardCode: string
  effect: string
  dispatched: boolean
  retryAllowed: boolean
  metadata: unknown
  resultFingerprint: string
  startedAt: number
  endedAt: number
  durationMs: number
}

interface RuntimeEventInput {
  group_id?: unknown
  groupId?: unknown
  user_id?: unknown
  userId?: unknown
  message_id?: unknown
  messageId?: unknown
  [key: string]: unknown
}

interface ExecutionRuntimeOptions {
  runId?: unknown
  userTurnId?: unknown
  prompt?: unknown
  config?: unknown
  event?: RuntimeEventInput | UnknownRecord | null
  scope?: unknown
  maxTurns?: unknown
  maxToolCalls?: unknown
  maxSideEffectCalls?: unknown
  maxConsecutiveGuardBlocks?: unknown
  maxNoProgress?: unknown
  defaultMaxAttempts?: unknown
}

interface GuardToolCallInput {
  tool?: unknown
  call?: UnknownRecord
  context?: UnknownRecord
  round?: unknown
}

interface ExecuteInvocationContext {
  markDispatched: () => { dispatched: true }
  signal: AbortSignal
}

interface ExecuteToolInput {
  guard?: GuardResult
  invoke?: (args: UnknownRecord, attempt: number, context: ExecuteInvocationContext) => Promise<unknown> | unknown
  signal?: AbortSignal
}

interface RecordExecutionInput {
  guard: GuardResult
  call?: UnknownRecord
  result?: UnknownRecord
  startedAt?: unknown
  endedAt?: unknown
}

interface RecordGuardInput {
  guard: GuardResult
  call?: UnknownRecord
  startedAt?: unknown
  endedAt?: unknown
}

const NUMBER_WORDS: Record<string, number> = {
  零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

const TRANSIENT_ERROR_PATTERN = /timeout|timed out|超时|暂时不可用|连接重置|网络错误|network|econnreset|eai_again|503|502|504/i
const AMBIGUOUS_ERROR_PATTERN = /timeout|timed out|超时|响应丢失|连接重置|econnreset|socket hang up|gateway/i

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function asInt(value: unknown, fallback = 0): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "工具执行失败")
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]"
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeValue(item, depth + 1))
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 500) : value
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
    key,
    /token|key|secret|password|credential|authorization|cookie/i.test(key)
      ? "<redacted>"
      : safeValue(item, depth + 1),
  ]))
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]"
  if (Array.isArray(value)) return value.map(item => stableValue(item, depth + 1))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value as UnknownRecord).sort().map(key => [key, stableValue((value as UnknownRecord)[key], depth + 1)]))
}

function readPath(value: unknown, pathValue = ""): unknown {
  return pathValue.split(".").filter(Boolean).reduce<unknown>((current, key) => record(current)[key], value)
}

function textHash(value: unknown): string {
  return createHash("sha256").update(text(value)).digest("hex").slice(0, 24)
}

function fingerprint(value: unknown): string {
  return textHash(JSON.stringify(stableValue(safeValue(value))))
}

function parseNumberWord(value = ""): number {
  const input = text(value).trim()
  if (/^\d+$/.test(input)) return Number(input)
  if (Object.hasOwn(NUMBER_WORDS, input)) return NUMBER_WORDS[input]
  const tenMatch = input.match(/^十([一二两三四五六七八九])$/)
  if (tenMatch) return 10 + NUMBER_WORDS[tenMatch[1]]
  const prefixTenMatch = input.match(/^([一二两三四五六七八九])十([一二两三四五六七八九])?$/)
  if (prefixTenMatch) return NUMBER_WORDS[prefixTenMatch[1]] * 10 + (prefixTenMatch[2] ? NUMBER_WORDS[prefixTenMatch[2]] : 0)
  return 0
}

function promptCount(prompt: string, execution: ToolExecutionPolicy): number {
  const config = execution.promptCount
  if (!config?.keywords?.length) return 0
  const clauses = prompt.split(/[，。！？；;、\n]+/).slice(0, Math.max(1, config.maxClauses || 4))
  const numberPattern = `(?:\\d+|[零一二两三四五六七八九十]+)`
  const unitPattern = (config.units || ["次", "下", "个"]).map(unit => text(unit).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const keywordPattern = config.keywords.map(keyword => text(keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  if (!unitPattern || !keywordPattern) return 0
  const countPattern = new RegExp(`(${numberPattern})\\s*(?:${unitPattern})`)
  const operationPattern = new RegExp(keywordPattern, "i")
  return clauses.reduce((total, clause) => {
    if (!operationPattern.test(clause)) return total
    const match = clause.match(countPattern)
    return total + (match ? Math.max(0, parseNumberWord(match[1])) : 0)
  }, 0)
}

function extractValues(args: unknown, fields: string[]): string[] {
  const values: unknown[] = []
  for (const field of fields) {
    const value = readPath(args, field)
    if (Array.isArray(value)) values.push(...value)
    else if (value !== undefined && value !== null && value !== "") values.push(value)
  }
  return [...new Set(values.map(value => text(value).trim()).filter(Boolean))]
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || /aborted|cancel|取消|终止/i.test(errorMessage(error))
}

function isAmbiguousError(error: unknown): boolean {
  return AMBIGUOUS_ERROR_PATTERN.test(errorMessage(error))
}

function isTransientError(error: unknown): boolean {
  return TRANSIENT_ERROR_PATTERN.test(errorMessage(error))
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!ms) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    }
    const finish = () => { cleanup(); resolve() }
    const abort = () => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error("工具执行已取消")) }
    if (signal?.aborted) return abort()
    timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

function operationId(scope: string, family: string, targetKey: string): string {
  return `op_${textHash(`${scope}|${family}|${targetKey}`)}`
}

function normalizeToolValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return /^(?:base64:\/\/|data:[^;,]+;base64,)/i.test(value) ? "[inline media omitted]" : value
  try {
    return JSON.stringify(value, (key, nested: unknown) => {
      if (key === "inlineData") return "[inline media omitted]"
      if (typeof nested === "string" && /^(?:base64:\/\/|data:[^;,]+;base64,)/i.test(nested)) return "[inline media omitted]"
      return nested
    }) || ""
  } catch {
    return String(value)
  }
}

function defaultScope(input: { scope?: unknown; event?: unknown } = {}): string {
  const event = record(input.event)
  if (input.scope) return text(input.scope)
  const group = event.group_id || event.groupId
  const user = event.user_id || event.userId
  const message = event.message_id || event.messageId
  if (group) return `g:${text(group)}:${text(message || user || "turn")}`
  return `p:${text(user || "unknown")}:${text(message || "turn")}`
}

function normalizeToolResult(value: unknown): NormalizedToolResult {
  const source = record(value)
  if (["observation", "delivery", "action", "error"].includes(text(source.kind)) && Array.isArray(source.chain)) {
    const output = source as unknown as ToolOutput
    const failed = source.kind === "error" || source.isError === true
    const summary = summarizeToolOutput(output)
    const receipt = record(source.receipt)
    const deliveryCompleted = source.kind === "delivery" && text(receipt.status) !== "failed"
    return {
      // 统一走脱敏后的序列化结果，避免非标准 structuredContent 把内联媒体
      // 或 data URL 原样带入模型请求、执行账本和链路日志。
      content: serializeToolOutput(output),
      status: failed ? "failed" : "success",
      // 一次结构化工具调用只占用一次操作额度，即使结果链包含多个媒体片段；
      // 部分投递仍算一次已发生的动作。
      executedCount: deliveryCompleted ? 1 : 0,
      targetCounts: {},
      retryAllowed: true,
      structured: true,
      dispatched: source.kind === "delivery" || source.kind === "action" || record(source.metadata).deliveryAttempted === true,
      metadata: {
        ...record(source.metadata),
        outputKind: source.kind,
        contentTypes: summary.contentTypes,
        mediaPartCount: source.chain.filter((part: unknown) => ["image", "audio", "video", "file"].includes(text(record(part).type))).length,
        receiptStatus: text(receipt.status),
        receiptPartCount: asInt(receipt.partCount),
        receiptSentCount: asInt(receipt.sentCount),
        receiptFailedCount: asInt(receipt.failedCount),
        normalizationIssues: Array.isArray(source.issues) ? source.issues : [],
      },
    }
  }
  if (typeof source.status === "string" && (Object.hasOwn(source, "content") || Object.hasOwn(source, "result"))) {
    return {
      content: source.content ?? source.result ?? "",
      status: source.status,
      executedCount: Math.max(0, asInt(source.executedCount)),
      targetCounts: record(source.targetCounts),
      retryAllowed: source.retryAllowed !== false,
      structured: true,
      dispatched: source.dispatched === true,
      metadata: record(source.metadata),
    }
  }
  const content = value
  const contentText = typeof content === "string" ? content.trim() : ""
  const looksLikeFailure = /^(缺少|无法|未能|失败|错误|禁止|拒绝|不支持|未启用|未知 action|当前消息.*没有)/i.test(contentText)
  return { content, status: looksLikeFailure ? "failed" : "success", executedCount: 0, targetCounts: {}, retryAllowed: true, structured: false, dispatched: false, metadata: {} }
}

/** 工具执行保护运行时：跨模型轮次维护操作额度、去重签名、重试和完整账本。 */
export function createExecutionRuntime(options: ExecutionRuntimeOptions = {}) {
  const config = record(options.config)
  const chat = record(config.chat)
  const executionConfig = record(chat.execution) as ExecutionConfig
  const configuredMaxTurns = options.maxTurns === null || options.maxTurns === undefined ? (chat.maxToolRounds ?? 3) : options.maxTurns
  const state: ExecutionState = {
    runId: text(options.runId),
    userTurnId: text(options.userTurnId),
    scope: defaultScope({ scope: options.scope, event: options.event }),
    turnCount: 0,
    toolCallCount: 0,
    sideEffectCount: 0,
    guardBlockStreak: 0,
    noProgressStreak: 0,
    pollDelayMs: 0,
    phase: "tools",
    finalizationReason: "",
    maxTurns: Math.max(0, asInt(configuredMaxTurns, 3)),
    maxToolCalls: Math.max(1, asInt(options.maxToolCalls || executionConfig.maxToolCalls, 20)),
    maxSideEffectCalls: Math.max(1, asInt(options.maxSideEffectCalls || executionConfig.maxSideEffectCalls, 20)),
    maxConsecutiveGuardBlocks: Math.max(1, asInt(options.maxConsecutiveGuardBlocks || executionConfig.maxConsecutiveGuardBlocks, 2)),
    maxNoProgress: Math.max(1, asInt(options.maxNoProgress || executionConfig.maxNoProgress, 3)),
    defaultMaxAttempts: Math.max(1, asInt(options.defaultMaxAttempts || executionConfig.defaultMaxAttempts, 2)),
  }
  const operations = new Map<string, ExecutionOperation>()
  const signatures = new Map<string, number>()
  const ledger: LedgerEntry[] = []

  function policyFor(tool: unknown, args: UnknownRecord = {}): { execution: ToolExecutionPolicy } {
    return resolveToolExecutionPolicy(tool, args)
  }

  function targetKeys(args: UnknownRecord, policy: { execution: ToolExecutionPolicy }, context: UnknownRecord = {}): string[] {
    const fields = policy.execution.targetFields || []
    if (fields.length === 1) {
      const values = extractValues(args, fields)
      if (values.length) return values.map(value => `${fields[0]}:${value}`)
    } else if (fields.length > 1) {
      const composite = fields.map(field => [field, readPath(args, field)] as const).filter(([, value]) => value !== undefined && value !== null && value !== "")
      if (composite.length) return [`${fields.join("+")}:${fingerprint(Object.fromEntries(composite))}`]
    }
    return [`scope:${text(context.scope || state.scope)}`]
  }

  function operationFields(args: UnknownRecord, policy: { execution: ToolExecutionPolicy }): UnknownRecord {
    const fields = policy.execution.operationFields || []
    if (!fields.length) return args
    return Object.fromEntries(fields.map(field => [field, readPath(args, field)]))
  }

  function requestedCount(args: UnknownRecord, policy: { execution: ToolExecutionPolicy }): number {
    if (!policy.execution.supportsCount) return 1
    const field = policy.execution.countField || "count"
    const explicit = Number(readPath(args, field))
    const fromArgs = Number.isFinite(explicit) && explicit > 0 ? explicit : 0
    const fromPrompt = promptCount(text(options.prompt), policy.execution)
    const authorized = policy.execution.repeatPolicy === toolRepeatPolicies.explicitOnly ? (fromPrompt || 1) : (fromPrompt || fromArgs || 1)
    return clamp(Math.trunc(authorized), 1, policy.execution.maxCount || 100)
  }

  function createOrGetOperation(input: { tool: unknown; args: UnknownRecord; policy: { execution: ToolExecutionPolicy }; targetKey: string; context: UnknownRecord }): ExecutionOperation {
    const common = getToolCommon(input.tool)
    const action = text(input.args.action).trim()
    const family = input.policy.execution.operationFamily || `${text(common.source) || "tool"}:${text(record(input.tool).name) || "unknown"}:${action}`
    const operationDiscriminator = input.policy.execution.supportsCount ? "counted" : fingerprint(operationFields(input.args, input.policy))
    const key = `${state.scope}|${family}|${input.targetKey}|${operationDiscriminator}`
    const existing = operations.get(key)
    if (existing) return existing
    const id = operationId(`${state.runId}|${state.userTurnId}|${state.scope}`, family, `${input.targetKey}|${operationDiscriminator}`)
    const requestedTotal = requestedCount(input.args, input.policy)
    const operation: ExecutionOperation = {
      id, key, family, targetKey: input.targetKey, tool: text(record(input.tool).name), requestedTotal,
      completedTotal: 0, remaining: requestedTotal, status: "pending", attempts: 0, polls: 0,
      lastResultFingerprint: "", context: { source: text(input.context.source), purpose: text(input.context.purpose) },
    }
    operations.set(key, operation)
    return operation
  }

  function guardToolCall(input: GuardToolCallInput = {}): GuardResult {
    const call = input.call || {}
    const context = input.context || {}
    const args = isRecord(call.arguments) ? { ...call.arguments } : {}
    const policy = policyFor(input.tool, args)
    const operationsForCall = targetKeys(args, policy, context).map(targetKey => createOrGetOperation({ tool: input.tool, args, policy, targetKey, context }))
    const signature = `${text(record(input.tool).name) || text(call.name)}:${fingerprint(operationFields(args, policy))}`
    const sideEffect = policy.execution.effect !== toolExecutionEffects.read

    if (policy.execution.supportsCount && policy.execution.repeatPolicy === toolRepeatPolicies.explicitOnly) {
      const field = policy.execution.countField || "count"
      const supplied = Math.max(0, asInt(readPath(args, field)))
      if (supplied > 1 && !promptCount(text(options.prompt), policy.execution)) args[field] = 1
    }
    const base = { policy, operations: operationsForCall, signature }
    if (state.phase !== "tools") return { ...base, decision: "finalize", code: "RUNTIME_FINALIZATION_MODE", message: "工具执行已进入最终收束阶段，不再执行新的工具调用。" }
    if (state.toolCallCount >= state.maxToolCalls) {
      enterFinalization("MAX_TOOL_CALLS")
      return { ...base, decision: "finalize", code: "MAX_TOOL_CALLS", message: `已达到本次请求的工具调用上限（${state.maxToolCalls}），将整理已有结果。` }
    }
    if (sideEffect && operationsForCall.some(operation => operation.status === "queued")) {
      state.guardBlockStreak++
      return { ...base, decision: "skip", code: "OPERATION_QUEUED", message: "该操作已经进入后台队列，当前轮次不重复排队。" }
    }
    const globalSideEffectRemaining = Math.max(0, state.maxSideEffectCalls - state.sideEffectCount)
    if (sideEffect && globalSideEffectRemaining <= 0) {
      enterFinalization("MAX_SIDE_EFFECT_CALLS")
      return { ...base, decision: "finalize", code: "MAX_SIDE_EFFECT_CALLS", message: `已达到本次请求的副作用执行上限（${state.maxSideEffectCalls}），将整理已有结果。` }
    }
    if (policy.execution.polling && !sideEffect && operationsForCall.length > 0 && operationsForCall.every(operation => operation.polls >= policy.execution.maxPolls)) {
      enterFinalization("POLLING_LIMIT")
      return { ...base, decision: "finalize", code: "POLLING_LIMIT", message: `工具 ${text(call.name)} 已达到轮询上限（${policy.execution.maxPolls}），将整理当前结果。` }
    }
    if (policy.execution.repeatPolicy === toolRepeatPolicies.dedupe && signatures.has(signature)) {
      state.guardBlockStreak++
      if (state.guardBlockStreak >= state.maxConsecutiveGuardBlocks) enterFinalization("REPEATED_GUARD_BLOCK")
      return { ...base, decision: "skip", code: "OPERATION_ALREADY_ATTEMPTED", message: `工具 ${text(call.name)} 的相同操作已经成功执行过，本次调用已跳过。` }
    }
    if (sideEffect && operationsForCall.some(operation => operation.status === "ambiguous")) {
      state.guardBlockStreak++
      if (state.guardBlockStreak >= state.maxConsecutiveGuardBlocks) enterFinalization("AMBIGUOUS_OPERATION")
      return { ...base, decision: "skip", code: "AMBIGUOUS_OPERATION", message: "该副作用上一次执行结果不确定，可能已经完成，本次重复调用已阻止。" }
    }
    const repeatAllowed = policy.execution.repeatPolicy === toolRepeatPolicies.allow
    if (sideEffect && !repeatAllowed) {
      const remaining = Math.min(...operationsForCall.map(operation => Math.max(0, operation.remaining)))
      if (remaining <= 0) {
        state.guardBlockStreak++
        if (state.guardBlockStreak >= state.maxConsecutiveGuardBlocks) enterFinalization("OPERATION_ALREADY_SATISFIED")
        return { ...base, decision: "skip", code: "OPERATION_ALREADY_SATISFIED", message: "用户请求的这个操作已经完成，不要继续对同一目标执行。" }
      }
    }
    if (sideEffect && policy.execution.supportsCount) {
      const field = policy.execution.countField || "count"
      const promptRequested = promptCount(text(options.prompt), policy.execution)
      const promptAuthoritative = policy.execution.repeatPolicy === toolRepeatPolicies.explicitOnly && promptRequested > 0
      const supplied = clamp(asInt(readPath(args, field), 1) || 1, 1, policy.execution.maxCount || 100)
      // 用户已经明确说了“戳 5 次”这类总数时，不能让模型传入的默认 count=1
      // 把一个完整动作拆成多轮；执行器将授权总数一次性写回工具参数。
      const requested = clamp(promptAuthoritative ? promptRequested : supplied, 1, policy.execution.maxCount || 100)
      const remaining = repeatAllowed ? policy.execution.maxCount || 100 : Math.min(...operationsForCall.map(operation => Math.max(0, operation.remaining)))
      const globalPerTarget = Math.floor(globalSideEffectRemaining / Math.max(1, operationsForCall.length))
      const allowed = Math.min(requested, remaining, globalPerTarget)
      if (allowed <= 0 && globalPerTarget <= 0) {
        enterFinalization("MAX_SIDE_EFFECT_CALLS")
        return { ...base, decision: "finalize", code: "MAX_SIDE_EFFECT_CALLS", message: `本次动作目标数量超过剩余副作用额度（剩余 ${globalSideEffectRemaining} 次），为避免部分执行已停止。` }
      }
      const countRewritten = allowed !== supplied
      if (countRewritten) args[field] = allowed
      state.guardBlockStreak = 0
      const code = promptAuthoritative && countRewritten
        ? "EXPLICIT_COUNT_APPLIED"
        : allowed !== requested
          ? "EFFECT_QUOTA_CLAMPED"
          : "ALLOW_SIDE_EFFECT"
      const message = code === "EXPLICIT_COUNT_APPLIED"
        ? `已按用户明确要求执行 ${allowed} 次。`
        : code === "EFFECT_QUOTA_CLAMPED"
          ? `本次动作已按剩余额度调整为 ${allowed} 次。`
          : ""
      return { ...base, decision: allowed > 0 ? "rewrite" : "skip", code, message, args, plannedCount: allowed * operationsForCall.length, round: asInt(input.round) }
    }
    if (sideEffect && operationsForCall.length > globalSideEffectRemaining) {
      enterFinalization("MAX_SIDE_EFFECT_CALLS")
      return { ...base, decision: "finalize", code: "MAX_SIDE_EFFECT_CALLS", message: `本次动作需要 ${operationsForCall.length} 次副作用额度，但当前只剩 ${globalSideEffectRemaining} 次，为避免部分执行已停止。` }
    }
    state.guardBlockStreak = 0
    return { ...base, decision: "allow", code: "ALLOW", args, plannedCount: sideEffect ? operationsForCall.length : 0, round: asInt(input.round) }
  }

  function markDispatched(): { dispatched: true } {
    return { dispatched: true }
  }

  async function executeTool(input: ExecuteToolInput = {}): Promise<ToolExecutionResult> {
    const guard = input.guard
    if (!guard || guard.decision === "skip") return { status: "skipped", value: guard?.message || "操作已跳过。", content: guard?.message || "操作已跳过。", executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, dispatched: false, metadata: {}, attempt: 0 }
    if (guard.decision === "finalize") return { status: "blocked", value: guard.message, content: guard.message, executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, dispatched: false, metadata: {}, attempt: 0 }
    if (!input.invoke) throw new Error("工具执行缺少 invoke 函数")
    const policy = guard.policy.execution
    const maxAttempts = Math.max(1, Math.min(5, asInt(policy.maxAttempts || state.defaultMaxAttempts, state.defaultMaxAttempts)))
    let attempt = 0
    let dispatched = false
    while (attempt < maxAttempts) {
      attempt++
      const timeoutMs = Math.max(1000, asInt(policy.timeoutMs || executionConfig.toolTimeoutMs, 60000))
      const controller = new AbortController()
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const abortFromParent = () => controller.abort(input.signal?.reason instanceof Error ? input.signal.reason : new Error("工具执行已取消"))
      if (input.signal?.aborted) abortFromParent()
      else input.signal?.addEventListener("abort", abortFromParent, { once: true })
      timer = setTimeout(() => { timedOut = true; controller.abort(new Error(`工具执行超过 ${timeoutMs}ms`)) }, timeoutMs)
      try {
        const value = await input.invoke(guard.args || {}, attempt, { markDispatched: () => { dispatched = true; return markDispatched() }, signal: controller.signal })
        const normalized = normalizeToolResult(value)
        dispatched = dispatched || normalized.dispatched
        return { ...normalized, value, attempt, dispatched, timedOut }
      } catch (error) {
        if (timedOut) {
          const ambiguous = dispatched && policy.effect !== toolExecutionEffects.read
          return { status: ambiguous ? "ambiguous" : "failed", error, attempt, dispatched, timedOut: true, value: ambiguous ? "工具执行超时，结果不确定，禁止自动重试。" : `工具执行超过 ${timeoutMs}ms。`, content: ambiguous ? "工具执行超时，结果不确定，禁止自动重试。" : `工具执行超过 ${timeoutMs}ms。`, executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, metadata: {} }
        }
        if (isAbortError(error, input.signal) || isAbortError(error, controller.signal)) return { status: "canceled", error, attempt, dispatched, value: "工具执行已取消。", content: "工具执行已取消。", executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, metadata: {} }
        const errorRecord = record(error)
        if (errorRecord.permissionDenied === true) return { status: "denied", error, attempt, dispatched, value: errorMessage(error) || "当前上下文没有权限执行该工具。", content: errorMessage(error), executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, metadata: {} }
        const ambiguous = dispatched || (policy.effect !== toolExecutionEffects.read && isAmbiguousError(error))
        const canRetry = !ambiguous && (policy.retryPolicy === toolRetryPolicies.safe || policy.retryPolicy === toolRetryPolicies.executor) && isTransientError(error) && attempt < maxAttempts
        if (!canRetry) {
          const value = ambiguous ? "工具请求结果不确定，动作可能已经完成，禁止自动重试。" : `工具执行失败：${errorMessage(error)}`
          return { status: ambiguous ? "ambiguous" : "failed", error, attempt, dispatched, value, content: value, executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, metadata: {} }
        }
        await delay(Math.min(1000, 100 * (2 ** (attempt - 1))), input.signal)
      } finally {
        if (timer) clearTimeout(timer)
        input.signal?.removeEventListener("abort", abortFromParent)
      }
    }
    return { status: "failed", attempt, dispatched, value: "工具执行失败。", content: "工具执行失败。", executedCount: 0, targetCounts: {}, retryAllowed: false, structured: false, metadata: {} }
  }

  function recordExecution(input: RecordExecutionInput): UnknownRecord {
    const guard = input.guard
    const call = input.call || {}
    const result = input.result || {}
    const normalized = normalizeToolResult(result.value ?? result)
    let status = !normalized.structured && normalized.status === "failed" ? "failed" : text(result.status || normalized.status || "success")
    const execution = guard.policy.execution
    const isSideEffect = execution.effect !== toolExecutionEffects.read
    let content = normalized.content ?? result.value ?? result
    if (status === "success" && isSideEffect && execution.supportsCount && !normalized.structured) {
      status = "failed"
      content = "工具未返回结构化执行结果，无法确认实际完成次数，已停止继续执行。"
    }
    if ((status === "failed" || status === "ambiguous") && normalized.executedCount > 0) status = "partial"
    const targetCount = guard.operations.length || 1
    const successful = status === "success" || status === "partial"
    const accepted = status === "accepted"
    const reportedTotal = successful && isSideEffect ? normalized.structured ? Math.max(0, normalized.executedCount) : targetCount : 0
    const plannedTotal = guard.plannedCount || (isSideEffect ? targetCount : 0)
    const actualTotal = Math.min(reportedTotal, plannedTotal || reportedTotal)
    const actualPerTarget = normalized.targetCounts
    const completed: OperationProgress[] = []
    const resultFingerprint = fingerprint(content)
    let sameReadResult = false
    for (const operation of guard.operations) {
      sameReadResult = sameReadResult || Boolean(operation.lastResultFingerprint && operation.lastResultFingerprint === resultFingerprint)
      const explicitIncrement = Object.hasOwn(actualPerTarget, operation.targetKey)
      const inferredIncrement = successful ? isSideEffect ? execution.supportsCount ? (actualTotal ? Math.ceil(actualTotal / targetCount) : 0) : 1 : 0 : 0
      const increment = explicitIncrement ? Math.max(0, asInt(actualPerTarget[operation.targetKey])) : inferredIncrement
      if (increment) operation.completedTotal = Math.min(operation.requestedTotal, operation.completedTotal + increment)
      operation.remaining = Math.max(0, operation.requestedTotal - operation.completedTotal)
      operation.attempts += Math.max(1, asInt(result.attempt, 1))
      if (execution.polling) operation.polls++
      operation.status = status === "accepted" ? "queued" : status === "success" || status === "partial" ? operation.remaining ? "partial" : "success" : status as OperationStatus
      operation.lastResultFingerprint = resultFingerprint
      completed.push({ operationId: operation.id, targetKey: operation.targetKey, requestedTotal: operation.requestedTotal, completedTotal: operation.completedTotal, remaining: operation.remaining })
    }
    state.toolCallCount++
    const accountedSideEffectCount = accepted ? Math.max(1, plannedTotal) : actualTotal
    state.sideEffectCount = Math.min(state.maxSideEffectCalls, state.sideEffectCount + Math.max(0, accountedSideEffectCount))
    if (successful && guard.signature && execution.repeatPolicy === toolRepeatPolicies.dedupe && completed.every(operation => operation.remaining <= 0)) signatures.set(guard.signature, Date.now())
    if (status === "success" && execution.effect === toolExecutionEffects.read) {
      if (execution.polling) { state.noProgressStreak = 0; state.pollDelayMs = Math.max(state.pollDelayMs, execution.minPollIntervalMs || 0) }
      else state.noProgressStreak = sameReadResult ? state.noProgressStreak + 1 : 0
    } else if (successful && actualTotal > 0) state.noProgressStreak = 0
    if (state.noProgressStreak >= state.maxNoProgress) enterFinalization("NO_PROGRESS")
    const hasRemaining = completed.some(operation => operation.remaining > 0)
    const validationError = record(normalized.metadata).validationError === true
    const retryableValidation = status === "failed" && validationError && result.dispatched !== true && normalized.dispatched !== true
    const retryAllowed = result.retryAllowed !== false
      && (retryableValidation || (!["failed", "ambiguous", "denied", "canceled"].includes(status)
        && (execution.effect === toolExecutionEffects.read ? execution.repeatPolicy !== toolRepeatPolicies.dedupe : hasRemaining)))
    const entry: LedgerEntry = {
      runId: state.runId,
      userTurnId: state.userTurnId,
      operationId: completed[0]?.operationId || "",
      operationIds: completed.map(item => item.operationId),
      toolUseId: text(call.id),
      tool: text(call.name),
      normalizedArgs: safeValue(guard.args || call.arguments || {}),
      targetKeys: completed.map(item => item.targetKey),
      requestedCount: completed.reduce((sum, item) => sum + item.requestedTotal, 0),
      executedCount: actualTotal,
      completedCount: completed.reduce((sum, item) => sum + item.completedTotal, 0),
      remainingCount: completed.reduce((sum, item) => sum + item.remaining, 0),
      attempt: asInt(result.attempt, 1),
      status,
      decision: guard.decision,
      guardCode: guard.code,
      effect: execution.effect,
      dispatched: result.dispatched === true || normalized.dispatched,
      retryAllowed,
      metadata: normalized.metadata,
      resultFingerprint,
      startedAt: asInt(input.startedAt),
      endedAt: asInt(input.endedAt),
      durationMs: Math.max(0, asInt(input.endedAt) - asInt(input.startedAt)),
    }
    ledger.push(entry)
    return { ...entry, operations: completed, status, content, retryAllowed, finalizationReason: state.finalizationReason }
  }

  function recordGuard(input: RecordGuardInput): UnknownRecord {
    const guard = input.guard
    const call = input.call || {}
    state.toolCallCount++
    const operations = guard.operations || []
    const entry: LedgerEntry = {
      runId: state.runId,
      userTurnId: state.userTurnId,
      operationId: operations[0]?.id || "",
      operationIds: operations.map(operation => operation.id),
      toolUseId: text(call.id),
      tool: text(call.name),
      normalizedArgs: safeValue(call.arguments || {}),
      targetKeys: operations.map(operation => operation.targetKey),
      requestedCount: operations.reduce((sum, operation) => sum + operation.requestedTotal, 0),
      executedCount: 0,
      completedCount: operations.reduce((sum, operation) => sum + operation.completedTotal, 0),
      remainingCount: operations.reduce((sum, operation) => sum + operation.remaining, 0),
      attempt: 0,
      status: guard.decision === "skip" ? "skipped" : "blocked",
      decision: guard.decision,
      guardCode: guard.code,
      effect: guard.policy.execution.effect,
      dispatched: false,
      retryAllowed: false,
      metadata: {},
      resultFingerprint: fingerprint(guard.message),
      startedAt: asInt(input.startedAt),
      endedAt: asInt(input.endedAt),
      durationMs: Math.max(0, asInt(input.endedAt) - asInt(input.startedAt)),
    }
    ledger.push(entry)
    return { ...entry, content: guard.message, operations: operations.map(operation => ({ operationId: operation.id, targetKey: operation.targetKey, requestedTotal: operation.requestedTotal, completedTotal: operation.completedTotal, remaining: operation.remaining })) }
  }

  function shouldFinalize(): boolean {
    return state.phase === "finalizing" || state.noProgressStreak >= state.maxNoProgress || state.toolCallCount >= state.maxToolCalls
  }

  /** 工具阶段终止统一通过这里迁移，调用方不直接改写运行时状态。 */
  function enterFinalization(reason: unknown): void {
    state.phase = "finalizing"
    state.finalizationReason = text(reason).trim() || state.finalizationReason || "RUNTIME_FINALIZATION"
  }

  async function waitForNextRound(signal?: AbortSignal): Promise<void> {
    const waitMs = Math.max(0, asInt(state.pollDelayMs))
    state.pollDelayMs = 0
    if (waitMs > 0) await delay(waitMs, signal)
  }

  function formatToolResult(result: unknown = {}): string {
    const value = record(result)
    const content = normalizeToolValue(value.content ?? value.value ?? "")
    const execution = {
      status: value.status || "success",
      operationId: value.operationId || record(Array.isArray(value.operations) ? value.operations[0] : null).operationId || "",
      executedCount: value.executedCount || 0,
      completedCount: value.completedCount || 0,
      remainingCount: value.remainingCount || 0,
      retryAllowed: value.retryAllowed !== false,
      guardCode: value.guardCode || "",
    }
    return `${content}\n工具执行状态：${JSON.stringify(execution)}`
  }

  function summary(): UnknownRecord {
    return {
      runId: state.runId,
      userTurnId: state.userTurnId,
      turnCount: state.turnCount,
      toolCallCount: state.toolCallCount,
      sideEffectCount: state.sideEffectCount,
      guardBlockStreak: state.guardBlockStreak,
      noProgressStreak: state.noProgressStreak,
      pollDelayMs: state.pollDelayMs,
      phase: state.phase,
      finalizationReason: state.finalizationReason,
      operations: [...operations.values()].map(operation => ({ ...operation })),
      ledger: ledger.map(item => ({ ...item })),
    }
  }

  return {
    state,
    policyFor,
    guardToolCall,
    executeTool,
    recordExecution,
    recordGuard,
    shouldFinalize,
    enterFinalization,
    waitForNextRound,
    formatToolContent: normalizeToolValue,
    formatToolResult,
    summary,
    get ledger(): LedgerEntry[] { return ledger },
  }
}
