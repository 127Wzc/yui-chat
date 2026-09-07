import crypto from "node:crypto"
import { configStore } from "../../config/store.js"
import { estimateTokens, messageTokens } from "../chat/token-budget.js"
import { sqliteClient } from "../storage/sqlite/client.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { getToolCommon, modelToolDefinition } from "../../tools/support/contract.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { errorDetails, errorSummary } from "../shared/error-details.js"
import type { ModelRequestCapture } from "../../models/protocol/types.js"

const DETAIL_QUEUE_LIMIT = 5000
const DETAIL_QUEUE_BYTE_LIMIT = 16 * 1024 * 1024
const MEMORY_LIMIT = 1000
const SNAPSHOT_MESSAGES_LIMIT = 256 * 1024
const SNAPSHOT_TOOLS_LIMIT = 256 * 1024
const SNAPSHOT_REQUEST_LIMIT = 32 * 1024
const SNAPSHOT_STRING_LIMIT = 12000
const FLUSH_INTERVAL_MS = 250
const FLUSH_BATCH_SIZE = 100
const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30000
const DAY_OFFSET_MS = 8 * 60 * 60 * 1000
const COST_CURRENCY = "CNY"
const RUN_LIST_COLUMNS = [
  "id", "source", "purpose", "conversation_key", "scope_type", "user_id", "group_id",
  "status", "started_at", "ended_at", "duration_ms", "input_tokens", "output_tokens", "total_tokens",
  "cached_tokens", "reasoning_tokens", "estimated_tokens", "model_calls", "tool_calls", "failed_tools",
  "estimated_cost",
]
const TERMINAL_STATUSES = new Set(["ok", "error", "denied", "failed", "ambiguous", "canceled", "blocked", "skipped", "partial", "silent", "interrupted"])
const SECRET_KEY = /token|key|secret|password|credential|authorization|cookie|api[_-]?key|encrypted[_-]?content/i

function opaqueIdForLog(value: unknown): string {
  const id = String(value ?? "").trim()
  if (!id || id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

type UnknownRecord = Record<string, unknown>
type SqlOperation = { sql: string; params: unknown[]; mode?: "run" | "get" | "all" }

interface LogRow extends UnknownRecord {
  id: string
  run_id?: string
  sequence?: number
  parent_run_id?: string
  source?: string
  purpose?: string
  conversation_key?: string
  scope_type?: string
  user_id?: string
  group_id?: string
  status?: string
  started_at: number
  ended_at: number
  duration_ms?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cached_tokens?: number
  reasoning_tokens?: number
  estimated_tokens?: number
  estimated_input_tokens?: number
  estimated_output_tokens?: number
  model_calls?: number
  tool_calls?: number
  failed_tools?: number
  estimated_cost?: number
  metadata_json?: string
  model_call_id?: string
  operation?: string
  messages_json?: string
  tools_json?: string
  request_json?: string
  message_count?: number
  tool_count?: number
  context_chars?: number
  tool_chars?: number
  truncated?: boolean | number
  redaction_version?: string
  captured_at?: number
  updated_at?: number
  arguments_json?: string
  result_text?: string
  error_message?: string
  model_name?: string
  model_identifier?: string
  provider_name?: string
  adapter?: string
  price_in?: number
  price_out?: number
  usage_source?: string
  input_text?: string
  requires_final_reply?: boolean | number
}

interface DetailEvent {
  kind: "run" | "model" | "snapshot" | "tool"
  row: LogRow
  terminal?: boolean
  priority?: "high"
  bytes?: number
}

interface DailyRollup {
  [key: string]: string | number
  day: string
  modelName: string
  purpose: string
  input: number
  output: number
  total: number
  estimated: number
  cached: number
  reasoning: number
  calls: number
  failures: number
  durationMs: number
  cost: number
}

interface TraceScope {
  scopeType: "group" | "private" | "system"
  userId: string
  groupId: string
}

interface UsageTotals {
  input: number
  output: number
  total: number
  cached: number
  reasoning: number
  estimated: number
}

interface UsageShape extends Omit<UsageTotals, "estimated"> {
  source: string
  inputKnown: boolean
  outputKnown: boolean
}

interface NormalizedUsage extends UsageShape {
  estimatedInput: number
  estimatedOutput: number
}

interface TraceRecord {
  id: string
  parentId: string
  source: string
  purpose: string
  promptText: string
  conversationKey: string
  scope: TraceScope
  startedAt: number
  sequence: number
  modelCalls: number
  toolCalls: number
  failedTools: number
  usage: UsageTotals
  cost: number
  persisted: boolean
  finished?: boolean
  terminalQueued?: boolean
  currentModelCallId?: string
  startRow: LogRow
  nextSequence(): number
}

interface ModelCallRecord {
  id: string
  trace: TraceRecord
  row: LogRow
  ownsTrace: boolean
  requestMeta: UnknownRecord
  snapshot?: LogRow
  finished?: boolean
  terminalQueued?: boolean
  traceUpdated?: boolean
}

interface ChannelLike {
  modelConfig?: UnknownRecord
  provider?: UnknownRecord
  name?: unknown
  id?: unknown
  model?: unknown
  stream?: boolean
  apiProvider?: unknown
  type?: unknown
}

interface RetentionSettings {
  detailDays: number
  aggregateDays: number
}

interface LogFilters extends UnknownRecord {
  before?: number
  from?: number
  to?: number
  status?: string
  model?: string
  purpose?: string
  source?: string
  userId?: string
  groupId?: string
  query?: string
  limit?: number
  cursor?: string
}

interface RunCursor {
  startedAt: number
  id: string
}

interface SummaryMetrics {
  input: number
  output: number
  total: number
  estimated: number
  cached: number
  reasoning: number
  calls: number
  failures: number
  durationMs: number
  cost: number
}

interface SummaryRow {
  day: string
  model_name: string
  purpose: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  estimated_tokens: number
  cached_tokens: number
  reasoning_tokens: number
  calls: number
  failures: number
  duration_ms: number
  estimated_cost: number
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  return errorSummary(error)
}

function failureMetadata(error: unknown, previousDetails: unknown = {}): UnknownRecord {
  if (!error) return {}
  const details = errorDetails(error)
  return {
    error: redactText(errorMessage(error), 500),
    // 调用方可能已经附带了步骤、响应摘要等诊断；模型/网络错误只补充字段，
    // 不覆盖这些更具体的失败上下文。
    errorDetails: { ...record(previousDetails), ...details },
  }
}

function isTraceRecord(value: unknown): value is TraceRecord {
  const source = record(value)
  return typeof source.id === "string"
    && typeof source.nextSequence === "function"
    && typeof source.scope === "object"
    && typeof source.usage === "object"
}

function now() { return Date.now() }

function dayOf(value = now()) {
  return new Date((Number(value) || now()) + DAY_OFFSET_MS).toISOString().slice(0, 10)
}

function asInt(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0
}

function asNumber(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function boundedText(value: unknown, limit = 20000): string {
  let text = ""
  try {
    text = String(value ?? "")
  } catch {
    try { text = JSON.stringify(value) || "" } catch { text = "[unserializable]" }
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…（日志已截断）` : text
}

function detailEventBytes(event: DetailEvent): number {
  const row = event?.row || {}
  const textFields = ["prompt_text", "response_text", "input_text", "error_message", "metadata_json", "arguments_json", "result_text", "messages_json", "tools_json", "request_json"]
  const textBytes = textFields.reduce((total, key) => total + Buffer.byteLength(String(row[key] || "")), 0)
  // 为对象、字段名和数组槽位预留固定开销，避免只按正文计量而低估内存占用。
  return textBytes + 512
}

function redactText(value: unknown = "", limit = 20000): string {
  const text = boundedText(value, limit)
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi, "<redacted-private-key>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted-jwt>")
    .replace(/\b(?:sk|rk|pk|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "<redacted-token>")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/((?:["']?)authorization(?:["']?)\s*[:=]\s*(?:["']?)(?:Basic|Bearer)\s+)[^"'\s,;}&]+/gi, "$1<redacted>")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1<redacted>@")
    .replace(/([?&](?:api[_-]?key|key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|token|secret|password|credential|authorization|cookie)(?:["']?)\s*[:=]\s*(?:["']?))[^"'\s,;}&]+/gi, "$1<redacted>")
  return boundedText(text, limit)
}

function messageText(value: unknown, depth = 0): string {
  if (depth > 3 || value === null || value === undefined) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(item => messageText(item, depth + 1)).filter(Boolean).join("\n")
  if (typeof value === "object") {
    const source = record(value)
    if (typeof source.text === "string") return source.text
    if (source.content !== undefined) return messageText(source.content, depth + 1)
    try { return JSON.stringify(redactValue(source)) } catch { return "[无法序列化的消息内容]" }
  }
  return ""
}

function memoryConsolidationInput(messages: readonly unknown[] = []): string {
  const transcript = (Array.isArray(messages) ? messages : []).map((message, index) => {
    const source = record(message)
    const role = String(source.role || "message")
    const content = messageText(source.content)
    return `【${index + 1} · ${role}】\n${content}`
  }).filter(Boolean).join("\n\n")
  // 这份内容只用于已显式启用的群聊记忆提炼审计。仍不复制可直接滥用的敏感值，
  // 但普通姓名、性别、爱好、年龄等信息会原样保留，方便判断模型为何提炼/漏提炼。
  return redactText(transcript, 30000)
    .replace(/(?<!\d)(?:\+?86[()+.\-\s]*)?\(?1[3-9]\)?(?:[()+.\-\s]*\d){9}(?!\d)/g, "<redacted-phone>")
    .replace(/\b\d{17}[\dXx]\b/g, "<redacted-id>")
    .replace(/\b(?:\d[ -]?){15,18}\d\b/g, "<redacted-card>")
    .replace(/((?:密码|口令|密钥|验证码|校验码|token|api[_ -]?key)\s*(?:是|为|[:：=])\s*)[^\s，。；,;]+/gi, "$1<redacted>")
    .replace(/((?:家庭住址|收货地址|联系地址|详细地址|地址|住址)\s*(?:是|为|[:：=])\s*)[^\n，。；;]{4,120}/gi, "$1<redacted-address>")
    .replace(/((?:我住在|我家在|居住于)\s*)[^\n，。；;]{2,100}?(?=(?:\d+(?:号|栋|幢|单元|室)|(?:路|街|巷|道|小区))[^\n，。；;]*)(?:[^\n，。；;]*)/g, "$1<redacted-address>")
}

function shouldStoreMemoryConsolidationInput({ source = "", purpose = "" }: { source?: unknown; purpose?: unknown } = {}): boolean {
  return String(source) === "group-memory-consolidation" || String(purpose) === "memory-consolidation"
}

function responseForLog({ source = "", purpose = "" }: { source?: unknown; purpose?: unknown } = {}, response: unknown = ""): string {
  return shouldStoreMemoryConsolidationInput({ source, purpose }) ? "" : redactText(response, 20000)
}

function redactValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY.test(String(key))) return "<redacted>"
  if (depth > 4) return "[truncated]"
  if (value === null || value === undefined || typeof value !== "object") {
    if (typeof value === "string") return redactText(value, 800)
    if (typeof value === "bigint") return value.toString()
    return value
  }
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactValue(item, "", depth + 1, seen))
  return Object.fromEntries(Object.entries(value).slice(0, 60).map(([name, item]) => [name, redactValue(item, name, depth + 1, seen)]))
}

// 请求快照需要比普通元数据保留更多正文，才能在详情窗口还原模型实际看到的上下文；
// 仍沿用同一组凭证字段脱敏规则，并对单值、层级、数组和对象键数设上限。
function snapshotValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY.test(String(key))) return "<redacted>"
  if (depth > 6) return "[truncated]"
  if (value === null || value === undefined || typeof value !== "object") {
    if (typeof value === "string") return redactText(value, SNAPSHOT_STRING_LIMIT)
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "function" || typeof value === "symbol") return "[omitted]"
    return value
  }
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length }
  if (Array.isArray(value)) return value.slice(0, 200).map(item => snapshotValue(item, "", depth + 1, seen))
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([name, item]) => [name, snapshotValue(item, name, depth + 1, seen)]))
}

function hostedToolSummaries(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : []).map(item => {
    const summary = { ...record(item) }
    delete summary.raw
    return snapshotValue(summary)
  })
}

function serializedSnapshotArray(value: unknown, limit: number, marker: UnknownRecord): { text: string; truncated: boolean } {
  const source = Array.isArray(value) ? value : []
  const encoded = JSON.stringify(source) || "[]"
  if (Buffer.byteLength(encoded) <= limit) return { text: encoded, truncated: false }
  for (let keep = source.length - 1; keep >= 0; keep--) {
    const candidate = [...source.slice(0, keep), { ...marker, omitted: source.length - keep }]
    const candidateText = JSON.stringify(candidate) || "[]"
    if (Buffer.byteLength(candidateText) <= limit) return { text: candidateText, truncated: true }
  }
  return { text: JSON.stringify([{ ...marker, omitted: source.length }]) || "[]", truncated: true }
}

function serializedSnapshotObject(value: unknown, limit: number): { text: string; truncated: boolean } {
  const safe = snapshotValue(value)
  const encoded = JSON.stringify(safe) || "{}"
  if (Buffer.byteLength(encoded) <= limit) return { text: encoded, truncated: false }
  return { text: JSON.stringify({ truncated: true, preview: redactText(encoded, Math.max(200, limit - 64)) }) || "{}", truncated: true }
}

function snapshotTool(tool: unknown): UnknownRecord {
  const source = record(tool)
  if (source.type && typeof source.execute !== "function") return snapshotValue(source) as UnknownRecord
  const common = getToolCommon(tool)
  return snapshotValue({
    ...modelToolDefinition(tool),
    source: common.source || "",
    category: common.category || "",
    risk: common.risk || "",
    tags: common.tags || [],
    delivery: common.delivery || "",
  }) as UnknownRecord
}

function snapshotRequest({ operation, source, purpose, channel, metadata, request }: {
  operation?: unknown
  source?: unknown
  purpose?: unknown
  channel?: ChannelLike
  metadata?: unknown
  request?: unknown
} = {}): UnknownRecord {
  const requestValue = record(request)
  return {
    operation: String(operation || "chat"),
    source: String(source || ""),
    purpose: String(purpose || "chat"),
    model: {
      name: modelNameOf(channel),
      identifier: String(channel?.model || ""),
      provider: providerNameOf(channel),
      adapter: String(channel?.type || ""),
      protocol: String(requestValue.protocol || protocolForAdapter(channel?.type)),
      stream: channel?.stream === true,
    },
    options: snapshotValue(request || {}),
    metadata: snapshotValue(metadata || {}),
  }
}

function buildModelSnapshot({ id, runId, sequence, operation, source, purpose, channel, messages, tools, metadata, request }: {
  id: string
  runId: string
  sequence: number
  operation: unknown
  source: unknown
  purpose: unknown
  channel: ChannelLike
  messages: readonly unknown[]
  tools: readonly unknown[]
  metadata: unknown
  request?: unknown
}): LogRow {
  const safeMessages = (Array.isArray(messages) ? messages : []).map(item => snapshotValue(item))
  const safeTools = (Array.isArray(tools) ? tools : []).map(item => snapshotTool(item))
  const messagesJson = serializedSnapshotArray(safeMessages, SNAPSHOT_MESSAGES_LIMIT, { type: "snapshot-truncation", section: "messages" })
  const toolsJson = serializedSnapshotArray(safeTools, SNAPSHOT_TOOLS_LIMIT, { type: "snapshot-truncation", section: "tools" })
  const requestJson = serializedSnapshotObject(snapshotRequest({ operation, source, purpose, channel, metadata, request }), SNAPSHOT_REQUEST_LIMIT)
  return {
    id,
    model_call_id: id,
    run_id: runId,
    sequence,
    operation: String(operation || "chat"),
    messages_json: messagesJson.text,
    tools_json: toolsJson.text,
    request_json: requestJson.text,
    message_count: Array.isArray(messages) ? messages.length : 0,
    tool_count: Array.isArray(tools) ? tools.length : 0,
    context_chars: Buffer.byteLength(messagesJson.text),
    tool_chars: Buffer.byteLength(toolsJson.text),
    truncated: messagesJson.truncated || toolsJson.truncated || requestJson.truncated,
    redaction_version: "v1",
    captured_at: now(),
    updated_at: now(),
    started_at: now(),
    ended_at: 0,
  }
}

function json(value: unknown, fallback = "{}"): string {
  try { return JSON.stringify(redactValue(value)) } catch { return fallback }
}

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  try {
    const parsed = JSON.parse(String(value || ""))
    return parsed === null || typeof parsed === "object" ? parsed : fallback
  } catch {
    return fallback
  }
}

function parseJson(value: unknown, fallback: UnknownRecord = {}): UnknownRecord {
  const parsed = parseJsonValue(value, fallback)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : fallback
}

function traceScope(event: unknown = {}): TraceScope {
  const safeEvent = record(event)
  const isGroup = isGroupEvent(safeEvent)
  const userId = String(safeEvent.user_id || record(safeEvent.sender).user_id || "")
  return {
    scopeType: isGroup ? "group" : (userId ? "private" : "system"),
    userId,
    groupId: isGroup ? groupIdFromEvent(safeEvent) : "",
  }
}

function usageShape(usage: unknown = {}): UsageShape {
  const sourceUsage = record(usage)
  const source = String(sourceUsage.source || sourceUsage.usageSource || "unknown")
  return {
    input: asInt(sourceUsage.input),
    output: asInt(sourceUsage.output),
    total: asInt(sourceUsage.total),
    cached: asInt(sourceUsage.cached),
    reasoning: asInt(sourceUsage.reasoning),
    source,
    inputKnown: sourceUsage.inputKnown === undefined ? source === "reported" : Boolean(sourceUsage.inputKnown),
    outputKnown: sourceUsage.outputKnown === undefined ? source === "reported" : Boolean(sourceUsage.outputKnown),
  }
}

function estimateRequestInput(meta: UnknownRecord = {}): number {
  if (meta.operation === "embedding") return Math.max(0, asInt(meta.estimatedInputTokens))
  const messages = Array.isArray(meta.messages) ? meta.messages : []
  const tools = Array.isArray(meta.tools) ? meta.tools : []
  return messages.reduce((sum: number, item: unknown) => sum + messageTokens(item), 0)
    + tools.reduce((sum: number, item: unknown) => {
      const source = record(item)
      return sum + estimateTokens({ name: source.name, description: source.description, parameters: source.parameters })
    }, 0)
}

function estimateResponseOutput(response: UnknownRecord = {}): number {
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : []
  return estimateTokens(response.text || "") + toolCalls.reduce((sum: number, item: unknown) => sum + estimateTokens(item), 0)
}

function normalizeUsage(response: UnknownRecord = {}, meta: UnknownRecord = {}): NormalizedUsage {
  const raw = usageShape(response.usage || {})
  const inputEstimate = estimateRequestInput(meta)
  const outputEstimate = estimateResponseOutput(response)
  if (raw.source === "reported" && raw.inputKnown && raw.outputKnown) {
    return { ...raw, estimatedInput: 0, estimatedOutput: 0 }
  }
  const input = raw.inputKnown ? raw.input : inputEstimate
  const output = raw.outputKnown ? raw.output : outputEstimate
  return {
    input,
    output,
    total: raw.total || input + output,
    cached: raw.cached,
    reasoning: raw.reasoning,
    source: raw.inputKnown && raw.outputKnown ? raw.source : (raw.inputKnown || raw.outputKnown ? "mixed" : (input || output ? "estimated" : "unknown")),
    estimatedInput: raw.inputKnown ? 0 : inputEstimate,
    estimatedOutput: raw.outputKnown ? 0 : outputEstimate,
    inputKnown: raw.inputKnown,
    outputKnown: raw.outputKnown,
  }
}

function modelNameOf(channel: ChannelLike = {}): string {
  return String(channel.modelConfig?.name || channel.name || channel.id || channel.model || "unknown")
}

function providerNameOf(channel: ChannelLike = {}): string {
  return String(channel.provider?.name || channel.provider?.id || channel.modelConfig?.apiProvider || channel.apiProvider || "")
}

function protocolForAdapter(value: unknown): string {
  const adapter = String(value || "").trim()
  if (adapter === "openai-responses") return "responses"
  if (["openai-compatible", "qwen", "chatglm"].includes(adapter)) return "chat-completions"
  if (adapter === "claude") return "claude-messages"
  if (adapter === "gemini") return "gemini-generate-content"
  if (adapter === "mock") return "mock"
  return adapter
}

function modelStreamValue(row: LogRow): boolean | null {
  const metadata = parseJson(row.metadata_json)
  if (!Object.hasOwn(metadata, "stream")) return null
  return metadata.stream === true
}

function modelSummary(rows: LogRow[] = []): UnknownRecord {
  const names = [...new Set(rows.map(row => String(row.model_name || "").trim()).filter(Boolean))]
  const adapters = [...new Set(rows.map(row => String(row.adapter || "").trim()).filter(Boolean))]
  const streams = [...new Set(rows.map(modelStreamValue))]
  const result: UnknownRecord = {
    model_names: names,
    model_adapters: adapters,
    model_streams: streams,
  }
  if (names.length) result.model_name = names.length === 1 ? names[0] : names.join("、")
  if (adapters.length) result.model_adapter = adapters.length === 1 ? adapters[0] : adapters.join("、")
  if (streams.length === 1) result.model_stream = streams[0]
  return result
}

function retention(config: unknown = configStore.get()): RetentionSettings {
  const root = record(config)
  const logging = record(root.logging)
  const history = record(logging.history)
  const detailDays = Math.max(1, Math.min(3650, Number(history.detailRetentionDays) || 7))
  const aggregateDays = Math.max(detailDays, Math.min(3650, Number(history.aggregateRetentionDays) || 90))
  return { detailDays, aggregateDays }
}

function encodeCursor(value: RunCursor | null | undefined): string {
  if (!value) return ""
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function decodeCursor(value: unknown): RunCursor | null {
  if (!value) return null
  try { return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")) } catch { return null }
}

function isTerminal(status: unknown): boolean { return TERMINAL_STATUSES.has(String(status || "")) }

function modelCallStatus(error: unknown): string {
  if (!error) return "ok"
  const source = record(error)
  return source.name === "AbortError" || /终止|取消|aborted|abort/i.test(boundedText(source.message || error, 500)) ? "canceled" : "error"
}

class ModelLogStore {
  enabled = true
  detailQueue: DetailEvent[] = []
  detailQueueBytes = 0
  memoryRuns = new Map<string, LogRow>()
  memoryModels = new Map<string, LogRow>()
  memorySnapshots = new Map<string, LogRow>()
  memoryTools = new Map<string, LogRow>()
  memoryDaily = new Map<string, DailyRollup>()
  timer: ReturnType<typeof setInterval> | null = null
  cleanupTimer: ReturnType<typeof setInterval> | null = null
  flushing = false
  flushPromise: Promise<boolean> | null = null
  cleanupPromise: Promise<UnknownRecord> | null = null
  cleanupChain = Promise.resolve()
  managementPaused = false
  nextRetryAt = 0
  retryDelayMs = RETRY_MIN_MS
  lastFlushAt = 0
  lastError = ""
  lastErrorAt = 0
  droppedEvents = 0
  settings: RetentionSettings = retention()

  captureSync<T>(label: string, operation: () => T, fallback: T | null = null, recover?: (error: unknown) => T | null): T | null {
    try {
      return operation()
    } catch (error) {
      this.noteError(error, label)
      if (recover) {
        try { return recover(error) } catch (recoveryError) { this.noteError(recoveryError, `${label}收敛`) }
      }
      return fallback
    }
  }

  start(config: unknown = configStore.get()): boolean {
    const retentionChanged = this.configure(config)
    if (!this.enabled) {
      if (this.timer) clearInterval(this.timer)
      if (this.cleanupTimer) clearInterval(this.cleanupTimer)
      this.timer = null
      this.cleanupTimer = null
      return retentionChanged
    }
    if (this.timer) return retentionChanged
    this.timer = setInterval(() => { this.flush().catch(err => this.noteError(err)) }, FLUSH_INTERVAL_MS)
    this.timer.unref?.()
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch(err => this.noteError(err))
    }, 86400000)
    this.cleanupTimer.unref?.()
    return retentionChanged
  }

  configure(config: unknown = configStore.get()): boolean {
    const next = retention(config)
    const retentionChanged = !this.settings || this.settings.detailDays !== next.detailDays || this.settings.aggregateDays !== next.aggregateDays
    this.settings = next
    this.enabled = record(record(config).logging).level !== "off"
    return retentionChanged
  }

  async stop({ flush = true, timeoutMs = 1500 }: { flush?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
    if (this.timer) clearInterval(this.timer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.timer = null
    this.cleanupTimer = null
    if (!flush) return false
    return this.flushBarrier(timeoutMs)
  }

  async waitForIdle(deadline: number): Promise<boolean> {
    while (this.flushing && now() < deadline) {
      const remaining = Math.max(1, deadline - now())
      const inFlight = this.flushPromise
      if (inFlight) {
        await Promise.race([
          inFlight.catch(() => false),
          new Promise(resolve => setTimeout(resolve, Math.min(25, remaining))),
        ])
      } else {
        await new Promise(resolve => setTimeout(resolve, Math.min(10, remaining)))
      }
    }
    return !this.flushing
  }

  async flushBarrier(timeoutMs = 1500): Promise<boolean> {
    const deadline = now() + Math.max(0, Number(timeoutMs) || 0)
    if (!(await this.waitForIdle(deadline))) return false
    const remaining = deadline - now()
    if (remaining <= 0) return false
    const task = this.flush(true).catch(error => { this.noteError(error); return false })
    return Promise.race<boolean>([
      task,
      new Promise(resolve => setTimeout(() => resolve(false), remaining)),
    ])
  }

  noteError(error: unknown, context = ""): void {
    let detail = "日志写入失败"
    try { detail = redactText(errorMessage(error) || detail, 300) } catch { detail = "未知日志错误" }
    const message = `${context ? `${context}：` : ""}${detail}`.slice(0, 300)
    this.lastError = message
    const nowValue = now()
    if (!this.lastErrorAt || nowValue - this.lastErrorAt > 30000) {
      this.lastErrorAt = nowValue
      try { hostRuntime.logger?.warn?.(`[yui-chat] 异步日志写入失败：${message}`) } catch { /* 诊断输出失败也不得进入业务调用栈。 */ }
    }
  }

  enqueueDetail(event: DetailEvent): void {
    if (!this.enabled || !event?.row?.id) return
    this.remember(event)
    const queued = { ...event, bytes: Number(event.bytes) || detailEventBytes(event) }
    if (queued.bytes > DETAIL_QUEUE_BYTE_LIMIT) {
      this.droppedEvents++
      return
    }
    while (this.detailQueue.length >= DETAIL_QUEUE_LIMIT || this.detailQueueBytes + queued.bytes > DETAIL_QUEUE_BYTE_LIMIT) {
      const index = this.detailQueue.findIndex(item => !item.terminal && item.priority !== "high")
      const [dropped] = index >= 0 ? this.detailQueue.splice(index, 1) : this.detailQueue.splice(0, 1)
      if (dropped) this.detailQueueBytes = Math.max(0, this.detailQueueBytes - (Number(dropped.bytes) || detailEventBytes(dropped)))
      this.droppedEvents++
    }
    this.detailQueue.push(queued)
    this.detailQueueBytes += queued.bytes
  }

  enqueueDaily(delta: DailyRollup): void {
    if (!this.enabled) return
    const key = `${delta.day}|${delta.modelName}|${delta.purpose}`
    const current = this.memoryDaily.get(key) || { ...delta, input: 0, output: 0, total: 0, estimated: 0, cached: 0, reasoning: 0, calls: 0, failures: 0, durationMs: 0, cost: 0 }
    const numeric = current as unknown as Record<string, number>
    for (const field of ["input", "output", "total", "estimated", "cached", "reasoning", "calls", "failures", "durationMs", "cost"]) numeric[field] = asNumber(numeric[field]) + asNumber(delta[field])
    this.memoryDaily.set(key, current)
  }

  remember(event: DetailEvent): void {
    const target = event.kind === "run"
      ? this.memoryRuns
      : event.kind === "tool"
        ? this.memoryTools
        : event.kind === "snapshot"
          ? this.memorySnapshots
          : this.memoryModels
    target.set(event.row.id, event.row)
    while (target.size > MEMORY_LIMIT) {
      const oldest = target.keys().next().value
      if (oldest === undefined) break
      target.delete(oldest)
    }
  }

  createTrace(options: UnknownRecord = {}): TraceRecord | null {
    return this.captureSync("准备模型调用日志", () => this.createTraceInternal(options))
  }

  createTraceInternal({ event = {}, source = "chat", purpose = source || "chat", parentId = "", conversationKey = "", prompt = "", metadata = {} }: {
    event?: unknown
    source?: unknown
    purpose?: unknown
    parentId?: unknown
    conversationKey?: unknown
    prompt?: unknown
    metadata?: unknown
  } = {}): TraceRecord | null {
    if (!this.enabled) return null
    const startedAt = now()
    const scope = traceScope(event)
    const trace: TraceRecord = {
      id: crypto.randomUUID(),
      parentId: String(parentId || ""),
      source: String(source || "chat"),
      purpose: String(purpose || source || "chat"),
      promptText: shouldStoreMemoryConsolidationInput({ source, purpose }) ? "" : redactText(prompt, 30000),
      conversationKey: String(conversationKey || ""),
      scope,
      startedAt,
      sequence: 0,
      modelCalls: 0,
      toolCalls: 0,
      failedTools: 0,
      usage: { input: 0, output: 0, total: 0, cached: 0, reasoning: 0, estimated: 0 },
      cost: 0,
      persisted: false,
      startRow: {} as LogRow,
      nextSequence() { this.sequence += 1; return this.sequence },
    }
    const row = {
      id: trace.id,
      source: trace.source,
      purpose: trace.purpose,
      parent_run_id: trace.parentId || "",
      conversation_key: trace.conversationKey,
      scope_type: scope.scopeType,
      user_id: scope.userId,
      group_id: scope.groupId,
      prompt_text: trace.promptText,
      response_text: "",
      status: "running",
      started_at: startedAt,
      ended_at: 0,
      duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      estimated_tokens: 0,
      model_calls: 0,
      tool_calls: 0,
      failed_tools: 0,
      estimated_cost: 0,
      metadata_json: json(metadata),
    }
    trace.startRow = row
    return trace
  }

  startTrace(trace: unknown): void {
    const run = isTraceRecord(trace) ? trace : null
    if (!run || run.persisted) return
    // conversationKey 可能在请求解析出渠道后才补齐；写入起始行前同步一次，
    // 让未完成运行也能被会话索引看到。
    run.startRow.conversation_key = run.conversationKey
    run.startRow.prompt_text = run.promptText
    this.enqueueDetail({ kind: "run", row: run.startRow, terminal: false })
    run.persisted = true
  }

  finishTrace(trace: unknown, options: UnknownRecord = {}): LogRow | null {
    const run = isTraceRecord(trace) ? trace : null
    return this.captureSync("完成模型调用日志", () => this.finishTraceInternal(run, options), null, error => this.finishTraceFallback(run, options, error))
  }

  finishTraceInternal(trace: TraceRecord | null, { status = "ok", response = "", error = "", metadata = {} }: { status?: unknown; response?: unknown; error?: unknown; metadata?: unknown } = {}): LogRow | null {
    if (!trace || trace.finished) return null
    if (!trace.persisted) {
      trace.finished = true
      return null
    }
    const endedAt = now()
    const row = {
      id: trace.id,
      source: trace.source,
      purpose: trace.purpose,
      conversation_key: trace.conversationKey,
      parent_run_id: trace.parentId || "",
      scope_type: trace.scope.scopeType,
      user_id: trace.scope.userId,
      group_id: trace.scope.groupId,
      prompt_text: trace.promptText,
      response_text: responseForLog(trace, response),
      status: String(status || "ok"),
      started_at: trace.startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt - trace.startedAt),
      input_tokens: asInt(trace.usage.input),
      output_tokens: asInt(trace.usage.output),
      total_tokens: asInt(trace.usage.total),
      cached_tokens: asInt(trace.usage.cached),
      reasoning_tokens: asInt(trace.usage.reasoning),
      estimated_tokens: asInt(trace.usage.estimated),
      model_calls: asInt(trace.modelCalls),
      tool_calls: asInt(trace.toolCalls),
      failed_tools: asInt(trace.failedTools),
      estimated_cost: asNumber(trace.cost),
      metadata_json: json({
        ...record(metadata),
        ...failureMetadata(error, record(metadata).errorDetails),
      }),
    }
    this.enqueueDetail({ kind: "run", row, terminal: true, priority: "high" })
    trace.terminalQueued = true
    trace.finished = true
    return row
  }

  finishTraceFallback(trace: TraceRecord | null, { status = "error", response = "", error = null, metadata = {} }: { status?: unknown; response?: unknown; error?: unknown; metadata?: unknown } = {}, captureError: unknown = null): LogRow | null {
    if (!trace || trace.finished) return null
    if (!trace.persisted) {
      trace.finished = true
      return null
    }
    const endedAt = now()
    const previous = this.memoryRuns.get(trace.id) || {}
    const row = {
      ...previous,
      id: trace.id,
      source: trace.source,
      purpose: trace.purpose,
      conversation_key: trace.conversationKey,
      parent_run_id: trace.parentId || "",
      scope_type: trace.scope?.scopeType || "",
      user_id: trace.scope?.userId || "",
      group_id: trace.scope?.groupId || "",
      prompt_text: trace.promptText,
      response_text: responseForLog(trace, response),
      status: boundedText(status || "error", 30),
      started_at: trace.startedAt,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt - trace.startedAt),
      input_tokens: asInt(trace.usage?.input),
      output_tokens: asInt(trace.usage?.output),
      total_tokens: asInt(trace.usage?.total),
      cached_tokens: asInt(trace.usage?.cached),
      reasoning_tokens: asInt(trace.usage?.reasoning),
      estimated_tokens: asInt(trace.usage?.estimated),
      model_calls: asInt(trace.modelCalls),
      tool_calls: asInt(trace.toolCalls),
      failed_tools: asInt(trace.failedTools),
      estimated_cost: asNumber(trace.cost),
      metadata_json: json({
        ...record(metadata),
        ...failureMetadata(error || captureError, record(metadata).errorDetails),
        ...(captureError && captureError !== error
          ? { captureError: redactText(errorMessage(captureError), 300), captureErrorDetails: errorDetails(captureError) }
          : {}),
      }),
    }
    if (!trace.terminalQueued) this.enqueueDetail({ kind: "run", row, terminal: true, priority: "high" })
    trace.terminalQueued = true
    trace.finished = true
    return row
  }

  beginModelCall(options: UnknownRecord = {}): ModelCallRecord | null {
    return this.captureSync("开始模型调用日志", () => this.beginModelCallInternal(options))
  }

  beginModelCallInternal({ trace = null, event = {}, source = "", purpose = "chat", operation = "chat", channel = {}, messages = [], tools = [], texts = [], parentToolId = "", metadata = {}, snapshotMetadata = metadata, request = {} }: {
    trace?: TraceRecord | null
    event?: unknown
    source?: unknown
    purpose?: unknown
    operation?: unknown
    channel?: ChannelLike
    messages?: readonly unknown[]
    tools?: readonly unknown[]
    texts?: readonly unknown[]
    parentToolId?: unknown
    metadata?: unknown
    snapshotMetadata?: unknown
    request?: unknown
  } = {}): ModelCallRecord | null {
    const ownsTrace = !trace
    const run = trace || this.createTrace({ event, source: source || purpose, purpose, metadata })
    if (!run) return null
    this.startTrace(run)
    const startedAt = now()
    const id = crypto.randomUUID()
    const requestValue = record(request)
    const row: LogRow = {
      id,
      run_id: run.id,
      parent_tool_id: String(parentToolId || ""),
      sequence: run.nextSequence(),
      purpose: String(purpose || run.purpose),
      model_name: modelNameOf(channel),
      model_identifier: String(channel.model || ""),
      provider_name: providerNameOf(channel),
      adapter: String(channel.type || ""),
      status: "running",
      started_at: startedAt,
      ended_at: 0,
      duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      estimated_input_tokens: estimateRequestInput({ operation, messages, tools, estimatedInputTokens: texts.reduce((sum: number, text: unknown) => sum + estimateTokens(text), 0) }),
      estimated_output_tokens: 0,
      usage_source: "unknown",
      price_in: asNumber(channel.modelConfig?.priceIn),
      price_out: asNumber(channel.modelConfig?.priceOut),
      estimated_cost: 0,
      error_message: "",
      input_text: shouldStoreMemoryConsolidationInput({ source, purpose }) ? memoryConsolidationInput(messages) : "",
      metadata_json: json({
        ...record(metadata),
        protocol: String(requestValue.protocol || record(metadata).protocol || ""),
        stream: channel.stream === true,
        messageCount: messages.length,
        toolCount: tools.length,
        embeddingTextCount: texts.length,
      }),
    }
    this.enqueueDetail({ kind: "model", row, terminal: false })
    const snapshot = buildModelSnapshot({
      id,
      runId: run.id,
      sequence: Number(row.sequence || 0),
      operation,
      source,
      purpose,
      channel,
      messages,
      tools,
      metadata: snapshotMetadata,
      request,
    })
    snapshot.started_at = startedAt
    snapshot.captured_at = startedAt
    snapshot.updated_at = startedAt
    this.enqueueDetail({ kind: "snapshot", row: snapshot, terminal: true, priority: "high" })
    run.currentModelCallId = id
    return { id, trace: run, row, ownsTrace, snapshot, requestMeta: { operation, messages, tools, estimatedInputTokens: row.estimated_input_tokens } }
  }

  /** 记录适配器已构建、即将发送的协议请求；只更新当前调用的有界快照。 */
  captureModelRequest(call: ModelCallRecord | null, capture: ModelRequestCapture = { protocol: "", body: {} }): void {
    if (!call || call.finished || !this.enabled) return
    try {
      const snapshot = call.snapshot || this.memorySnapshots.get(call.id)
      if (!snapshot) return
      const request = parseJson(snapshot.request_json)
      const protocol = String(capture.protocol || "")
      const phase = String(capture.phase || "")
      const rawRequests = Array.isArray(request.rawRequests) ? request.rawRequests : []
      const item = snapshotValue({
        capturedAt: now(),
        ...(protocol ? { protocol } : {}),
        ...(phase ? { phase } : {}),
        body: Object.hasOwn(capture, "body") ? capture.body : {},
      })
      const next = [...rawRequests, item].slice(-8)
      const serialized = serializedSnapshotObject({ ...request, rawRequests: next }, SNAPSHOT_REQUEST_LIMIT)
      snapshot.request_json = serialized.text
      snapshot.truncated = Boolean(snapshot.truncated || serialized.truncated)
      snapshot.updated_at = now()
      this.enqueueDetail({ kind: "snapshot", row: snapshot, terminal: true, priority: "high" })
    } catch (error) {
      this.noteError(error, "记录原始模型请求")
    }
  }

  completeModelCall(call: ModelCallRecord | null, options: UnknownRecord = {}): LogRow | null {
    return this.captureSync("完成模型调用日志", () => this.completeModelCallInternal(call, options), null, error => this.completeModelCallFallback(call, options, error))
  }

  completeModelCallInternal(call: ModelCallRecord | null, { response = {}, error = null }: { response?: UnknownRecord; error?: unknown } = {}): LogRow | null {
    if (!call || call.finished) return null
    const endedAt = now()
    const usage = normalizeUsage(response, call.requestMeta)
    if (error && !response?.usage) usage.source = "unknown"
    const status = modelCallStatus(error)
    const previousMetadata = parseJson(call.row.metadata_json)
    const row = {
      ...call.row,
      status,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt - call.row.started_at),
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total,
      cached_tokens: usage.cached,
      reasoning_tokens: usage.reasoning,
      estimated_input_tokens: usage.estimatedInput,
      estimated_output_tokens: usage.estimatedOutput,
      usage_source: usage.source,
      estimated_cost: ((usage.input / 1000000) * asNumber(call.row.price_in)) + ((usage.output / 1000000) * asNumber(call.row.price_out)),
      error_message: error ? redactText(errorMessage(error), 500) : "",
      metadata_json: json({
        ...previousMetadata,
        responseId: opaqueIdForLog(response.id),
        responseText: responseForLog(call.row, response.text || ""),
        stopReason: response.stopReason || "unknown",
        toolCalls: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
        hostedToolCalls: hostedToolSummaries(response.hostedToolCalls),
        ...(Object.keys(record(response.responsesStateRecovery)).length
          ? { responsesStateRecovery: record(response.responsesStateRecovery) }
          : {}),
        ...(error ? { errorDetails: { ...record(previousMetadata.errorDetails), ...errorDetails(error) } } : {}),
      }),
    }
    const budgetEstimate = call.requestMeta.operation === "embedding"
      ? (usage.input || call.row.estimated_input_tokens || 0)
      : usage.estimatedInput + usage.estimatedOutput
    this.enqueueDetail({ kind: "model", row, terminal: true, priority: "high" })
    call.terminalQueued = true
    const trace = call.trace
    trace.modelCalls += 1
    trace.usage.input += asInt(usage.input)
    trace.usage.output += asInt(usage.output)
    trace.usage.total += asInt(usage.total)
    trace.usage.cached += asInt(usage.cached)
    trace.usage.reasoning += asInt(usage.reasoning)
    trace.usage.estimated += asInt(budgetEstimate)
    trace.cost += asNumber(row.estimated_cost)
    call.traceUpdated = true
    // SQLite 可用时由终态模型调用的触发器维护日汇总；内存日账本只服务于
    // SQLite 不可用时的降级展示，避免两份长期聚合状态并行累积。
    if (!sqliteClient.status.available) {
      this.enqueueDaily({
        day: dayOf(call.row.started_at),
        modelName: String(row.model_name || ""),
        purpose: String(row.purpose || ""),
        input: usage.input,
        output: usage.output,
        total: usage.total,
        estimated: budgetEstimate,
        cached: usage.cached,
        reasoning: usage.reasoning,
        calls: 1,
        failures: status === "ok" ? 0 : 1,
        durationMs: asNumber(row.duration_ms),
        cost: asNumber(row.estimated_cost),
      })
    }
    if (call.ownsTrace) this.finishTrace(trace, { status, response: response.text, error })
    call.finished = true
    return row
  }

  completeModelCallFallback(call: ModelCallRecord | null, { response = {}, error = null }: { response?: UnknownRecord; error?: unknown } = {}, captureError: unknown = null): LogRow | null {
    if (!call || call.finished) return null
    const endedAt = now()
    const failure = error || captureError
    const status = modelCallStatus(failure)
    const previousMetadata = parseJson(call.row.metadata_json)
    const row = {
      ...call.row,
      status,
      ended_at: endedAt,
      duration_ms: Math.max(0, endedAt - call.row.started_at),
      usage_source: "unknown",
      error_message: failure ? redactText(errorMessage(failure), 500) : "",
      metadata_json: json({
        ...previousMetadata,
        ...failureMetadata(failure, previousMetadata.errorDetails),
        ...(captureError && captureError !== error
          ? { captureError: redactText(errorMessage(captureError), 300), captureErrorDetails: errorDetails(captureError) }
          : {}),
      }),
    }
    if (!call.terminalQueued) this.enqueueDetail({ kind: "model", row, terminal: true, priority: "high" })
    call.terminalQueued = true
    if (!call.traceUpdated) {
      call.trace.modelCalls += 1
      call.traceUpdated = true
    }
    if (call.ownsTrace) this.finishTrace(call.trace, { status, response: response?.text, error: error || captureError })
    call.finished = true
    return row
  }

  recordToolCall(trace: unknown, options: UnknownRecord = {}): LogRow | null {
    const run = isTraceRecord(trace) ? trace : null
    return this.captureSync("记录工具调用日志", () => this.recordToolCallInternal({ ...options, trace: run }))
  }

  recordToolCallInternal({
    trace = null,
    modelCallId = "",
    round = 0,
    callIndex = 0,
    toolCallId = "",
    parentToolId = "",
    toolName = "",
    source = "",
    category = "",
    status = "ok",
    startedAt = 0,
    endedAt = 0,
    durationMs = 0,
    delivery = "",
    requiresFinalReply = true,
    arguments: toolArguments = {},
    result = "",
    resultChars = 0,
    error = "",
    metadata = {},
  }: {
    trace?: TraceRecord | null
    modelCallId?: unknown
    round?: unknown
    callIndex?: unknown
    toolCallId?: unknown
    parentToolId?: unknown
    toolName?: unknown
    source?: unknown
    category?: unknown
    status?: unknown
    startedAt?: unknown
    endedAt?: unknown
    durationMs?: unknown
    delivery?: unknown
    requiresFinalReply?: unknown
    arguments?: unknown
    result?: unknown
    resultChars?: unknown
    error?: unknown
    metadata?: unknown
  } = {}): LogRow | null {
    if (!trace || !this.enabled) return null
    const started = Number(startedAt) || now()
    const ended = Number(endedAt) || now()
    const finalStatus = boundedText(status || "ok", 30)
    const row = {
      id: crypto.randomUUID(),
      run_id: trace.id,
      model_call_id: String(modelCallId || trace.currentModelCallId || ""),
      parent_tool_id: String(parentToolId || ""),
      round: asInt(round),
      call_index: asInt(callIndex),
      tool_call_id: String(toolCallId || ""),
      tool_name: String(toolName || ""),
      source: String(source || ""),
      category: String(category || ""),
      status: finalStatus,
      started_at: started,
      ended_at: ended,
      duration_ms: Math.max(0, asInt(durationMs) || ended - started),
      result_chars: asInt(resultChars),
      delivery: String(delivery || ""),
      requires_final_reply: Boolean(requiresFinalReply),
      arguments_json: boundedText(json(toolArguments), 16000),
      result_text: redactText(result, 16000),
      error_message: error ? redactText(error, 500) : "",
      metadata_json: json(metadata),
    }
    trace.toolCalls += 1
    if (["error", "denied", "failed", "ambiguous", "canceled", "interrupted", "blocked"].includes(finalStatus)) trace.failedTools += 1
    this.enqueueDetail({ kind: "tool", row, terminal: true, priority: "high" })
    return row
  }

  async flush(force = false): Promise<boolean> {
    if (this.flushing || this.managementPaused || (!force && now() < this.nextRetryAt)) return false
    if (!this.detailQueue.length) return true
    if (!sqliteClient.status.available) {
      this.noteError("SQLite 不可用，日志仅保留在当前进程内存中")
      this.nextRetryAt = now() + this.retryDelayMs
      this.retryDelayMs = Math.min(RETRY_MAX_MS, this.retryDelayMs * 2)
      return false
    }
    this.flushing = true
    const detailTarget = force ? this.detailQueue.length : Math.min(FLUSH_BATCH_SIZE, this.detailQueue.length)
    const task = this.flushSnapshot(detailTarget)
    this.flushPromise = task
    try {
      return await task
    } finally {
      if (this.flushPromise === task) this.flushPromise = null
      this.flushing = false
    }
  }

  async flushSnapshot(detailTarget: number): Promise<boolean> {
    let remainingDetails = detailTarget
    while (remainingDetails > 0) {
      if (!sqliteClient.status.available) {
        this.noteError("SQLite 不可用，日志仅保留在当前进程内存中")
        this.nextRetryAt = now() + this.retryDelayMs
        this.retryDelayMs = Math.min(RETRY_MAX_MS, this.retryDelayMs * 2)
        return false
      }
      const detailCount = Math.min(FLUSH_BATCH_SIZE, remainingDetails, this.detailQueue.length)
      if (!detailCount) return true
      const details = this.detailQueue.splice(0, detailCount)
      this.detailQueueBytes = Math.max(0, this.detailQueueBytes - details.reduce((total, event) => total + (Number(event.bytes) || detailEventBytes(event)), 0))
      const runIds = new Set(details.filter(item => item.kind === "run").map(item => item.row.id))
      const modelIds = new Set(details.filter(item => item.kind === "model").map(item => item.row.id))
      // 快照与模型起始事件分别受队列淘汰影响时，补回模型父行，避免快照外键失败。
      for (const event of details.filter(item => item.kind === "snapshot")) {
        const modelId = String(event.row.model_call_id || event.row.id || "")
        if (!modelId || modelIds.has(modelId)) continue
        const remembered = this.memoryModels.get(modelId)
        const modelEvent: DetailEvent = {
          kind: "model",
          terminal: false,
          row: remembered || {
            id: modelId,
            run_id: event.row.run_id || "",
            parent_tool_id: "",
            sequence: asInt(event.row.sequence),
            purpose: "",
            model_name: "",
            model_identifier: "",
            provider_name: "",
            adapter: "",
            status: "running",
            started_at: Number(event.row.started_at || now()),
            ended_at: 0,
            duration_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cached_tokens: 0,
            reasoning_tokens: 0,
            estimated_input_tokens: 0,
            estimated_output_tokens: 0,
            usage_source: "unknown",
            price_in: 0,
            price_out: 0,
            estimated_cost: 0,
            error_message: "",
            input_text: "",
            metadata_json: "{}",
          },
        }
        modelEvent.bytes = detailEventBytes(modelEvent)
        details.push(modelEvent)
        modelIds.add(modelId)
      }
      for (const event of details.filter(item => item.kind !== "run")) {
        const runId = String(event.row.run_id || "")
        if (!runId || runIds.has(runId)) continue
        const remembered = this.memoryRuns.get(runId)
        const startedAt = Number(event.row.started_at || now())
        const parentEvent: DetailEvent = {
          kind: "run",
          terminal: false,
          row: remembered || {
            id: runId,
            source: event.row.source || "",
            purpose: event.row.purpose || "",
            conversation_key: "",
            scope_type: "",
            user_id: "",
            group_id: "",
            prompt_text: "",
            response_text: "",
            status: "running",
            started_at: startedAt,
            ended_at: 0,
            duration_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            cached_tokens: 0,
            reasoning_tokens: 0,
            estimated_tokens: 0,
            model_calls: 0,
            tool_calls: 0,
            failed_tools: 0,
            estimated_cost: 0,
            metadata_json: "{}",
          },
        }
        parentEvent.bytes = detailEventBytes(parentEvent)
        details.push(parentEvent)
        runIds.add(runId)
      }
      // 同一批次可能因队列淘汰或重试而乱序；先写父级 run，再写模型子事件，避免外键约束阻断收敛。
      const kindOrder = { run: 0, model: 1, snapshot: 2, tool: 3 }
      details.sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9))
      const operations = []
      for (const event of details) operations.push(this.upsertOperation(event))
      try {
        await sqliteClient.transaction(operations)
        remainingDetails -= detailCount
        this.lastFlushAt = now()
        this.lastError = ""
        this.retryDelayMs = RETRY_MIN_MS
        this.nextRetryAt = 0
      } catch (error) {
        this.detailQueue.unshift(...details)
        this.detailQueueBytes += details.reduce((total, event) => total + (Number(event.bytes) || detailEventBytes(event)), 0)
        this.noteError(error)
        this.nextRetryAt = now() + this.retryDelayMs
        this.retryDelayMs = Math.min(RETRY_MAX_MS, this.retryDelayMs * 2)
        return false
      }
    }
    return true
  }

  upsertOperation(event: DetailEvent): SqlOperation {
    const row = event.row
    if (event.kind === "run") return {
      sql: `INSERT INTO ai_runs(id, source, purpose, parent_run_id, conversation_key, scope_type, user_id, group_id, prompt_text, response_text, status, started_at, ended_at, duration_ms, input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens, estimated_tokens, model_calls, tool_calls, failed_tools, estimated_cost, metadata_json)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET source=excluded.source, purpose=excluded.purpose, conversation_key=excluded.conversation_key, scope_type=excluded.scope_type, user_id=excluded.user_id, group_id=excluded.group_id, response_text=CASE WHEN excluded.response_text<>'' THEN excluded.response_text ELSE ai_runs.response_text END, status=CASE WHEN excluded.ended_at=0 AND ai_runs.ended_at>0 THEN ai_runs.status ELSE excluded.status END, started_at=MIN(ai_runs.started_at, excluded.started_at), ended_at=MAX(ai_runs.ended_at, excluded.ended_at), duration_ms=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.duration_ms ELSE ai_runs.duration_ms END, input_tokens=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.input_tokens ELSE ai_runs.input_tokens END, output_tokens=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.output_tokens ELSE ai_runs.output_tokens END, total_tokens=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.total_tokens ELSE ai_runs.total_tokens END, cached_tokens=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.cached_tokens ELSE ai_runs.cached_tokens END, reasoning_tokens=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.reasoning_tokens ELSE ai_runs.reasoning_tokens END, estimated_tokens=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.estimated_tokens ELSE ai_runs.estimated_tokens END, model_calls=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.model_calls ELSE ai_runs.model_calls END, tool_calls=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.tool_calls ELSE ai_runs.tool_calls END, failed_tools=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.failed_tools ELSE ai_runs.failed_tools END, estimated_cost=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.estimated_cost ELSE ai_runs.estimated_cost END, metadata_json=CASE WHEN excluded.ended_at>0 OR ai_runs.ended_at=0 THEN excluded.metadata_json ELSE ai_runs.metadata_json END`,
      params: [row.id, row.source, row.purpose, row.parent_run_id || "", row.conversation_key, row.scope_type, row.user_id, row.group_id, row.prompt_text || "", row.response_text || "", row.status, row.started_at, row.ended_at, row.duration_ms, row.input_tokens, row.output_tokens, row.total_tokens, row.cached_tokens, row.reasoning_tokens, row.estimated_tokens, row.model_calls, row.tool_calls, row.failed_tools, row.estimated_cost, row.metadata_json],
    }
    if (event.kind === "model") return {
      sql: `INSERT INTO model_call_events(id, run_id, parent_tool_id, sequence, purpose, model_name, model_identifier, provider_name, adapter, status, started_at, ended_at, duration_ms, input_tokens, output_tokens, total_tokens, cached_tokens, reasoning_tokens, estimated_input_tokens, estimated_output_tokens, usage_source, price_in, price_out, estimated_cost, error_message, input_text, metadata_json)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, sequence=excluded.sequence, purpose=excluded.purpose, model_name=excluded.model_name, model_identifier=excluded.model_identifier, provider_name=excluded.provider_name, adapter=excluded.adapter, status=CASE WHEN excluded.ended_at=0 AND model_call_events.ended_at>0 THEN model_call_events.status ELSE excluded.status END, started_at=MIN(model_call_events.started_at, excluded.started_at), ended_at=MAX(model_call_events.ended_at, excluded.ended_at), duration_ms=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.duration_ms ELSE model_call_events.duration_ms END, input_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.input_tokens ELSE model_call_events.input_tokens END, output_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.output_tokens ELSE model_call_events.output_tokens END, total_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.total_tokens ELSE model_call_events.total_tokens END, cached_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.cached_tokens ELSE model_call_events.cached_tokens END, reasoning_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.reasoning_tokens ELSE model_call_events.reasoning_tokens END, estimated_input_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.estimated_input_tokens ELSE model_call_events.estimated_input_tokens END, estimated_output_tokens=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.estimated_output_tokens ELSE model_call_events.estimated_output_tokens END, usage_source=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.usage_source ELSE model_call_events.usage_source END, price_in=excluded.price_in, price_out=excluded.price_out, estimated_cost=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.estimated_cost ELSE model_call_events.estimated_cost END, error_message=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.error_message ELSE model_call_events.error_message END, input_text=CASE WHEN excluded.input_text<>'' THEN excluded.input_text ELSE model_call_events.input_text END, metadata_json=CASE WHEN excluded.ended_at>0 OR model_call_events.ended_at=0 THEN excluded.metadata_json ELSE model_call_events.metadata_json END`,
      params: [row.id, row.run_id, row.parent_tool_id || "", row.sequence, row.purpose, row.model_name, row.model_identifier, row.provider_name, row.adapter, row.status, row.started_at, row.ended_at, row.duration_ms, row.input_tokens, row.output_tokens, row.total_tokens, row.cached_tokens, row.reasoning_tokens, row.estimated_input_tokens, row.estimated_output_tokens, row.usage_source, row.price_in, row.price_out, row.estimated_cost, row.error_message, row.input_text || "", row.metadata_json],
    }
    if (event.kind === "snapshot") return {
      sql: `INSERT INTO model_call_snapshots(model_call_id, run_id, sequence, operation, messages_json, tools_json, request_json, message_count, tool_count, context_chars, tool_chars, truncated, redaction_version, captured_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(model_call_id) DO UPDATE SET run_id=excluded.run_id, sequence=excluded.sequence, operation=excluded.operation, messages_json=excluded.messages_json, tools_json=excluded.tools_json, request_json=excluded.request_json, message_count=excluded.message_count, tool_count=excluded.tool_count, context_chars=excluded.context_chars, tool_chars=excluded.tool_chars, truncated=excluded.truncated, redaction_version=excluded.redaction_version, captured_at=excluded.captured_at, updated_at=excluded.updated_at`,
      params: [row.model_call_id || row.id, row.run_id, row.sequence, row.operation || "chat", row.messages_json || "[]", row.tools_json || "[]", row.request_json || "{}", asInt(row.message_count), asInt(row.tool_count), asInt(row.context_chars), asInt(row.tool_chars), row.truncated ? 1 : 0, row.redaction_version || "v1", row.captured_at || now(), row.updated_at || now()],
    }
    return {
      sql: `INSERT INTO tool_call_events(id, run_id, model_call_id, parent_tool_id, round, call_index, tool_call_id, tool_name, source, category, status, started_at, ended_at, duration_ms, result_chars, delivery, requires_final_reply, arguments_json, result_text, error_message, metadata_json)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id, model_call_id=excluded.model_call_id, round=excluded.round, call_index=excluded.call_index, tool_call_id=excluded.tool_call_id, tool_name=excluded.tool_name, source=excluded.source, category=excluded.category, status=CASE WHEN excluded.ended_at=0 AND tool_call_events.ended_at>0 THEN tool_call_events.status ELSE excluded.status END, started_at=MIN(tool_call_events.started_at, excluded.started_at), ended_at=MAX(tool_call_events.ended_at, excluded.ended_at), duration_ms=CASE WHEN excluded.ended_at>0 OR tool_call_events.ended_at=0 THEN excluded.duration_ms ELSE tool_call_events.duration_ms END, result_chars=CASE WHEN excluded.ended_at>0 OR tool_call_events.ended_at=0 THEN excluded.result_chars ELSE tool_call_events.result_chars END, delivery=excluded.delivery, requires_final_reply=excluded.requires_final_reply, arguments_json=CASE WHEN excluded.arguments_json<>'{}' THEN excluded.arguments_json ELSE tool_call_events.arguments_json END, result_text=CASE WHEN excluded.result_text<>'' THEN excluded.result_text ELSE tool_call_events.result_text END, error_message=CASE WHEN excluded.ended_at>0 OR tool_call_events.ended_at=0 THEN excluded.error_message ELSE tool_call_events.error_message END, metadata_json=CASE WHEN excluded.ended_at>0 OR tool_call_events.ended_at=0 THEN excluded.metadata_json ELSE tool_call_events.metadata_json END`,
      params: [row.id, row.run_id, row.model_call_id, row.parent_tool_id || "", row.round, row.call_index, row.tool_call_id, row.tool_name, row.source, row.category, row.status, row.started_at, row.ended_at, row.duration_ms, row.result_chars, row.delivery, row.requires_final_reply ? 1 : 0, row.arguments_json || "{}", row.result_text || "", row.error_message || "", row.metadata_json || "{}"],
    }
  }

  // 所有清理共用同一条串行链：带筛选清理按“先 SELECT 快照、再扣减日汇总”执行，
  // 两个清理（含 24 小时定时保留清理）并发交错会按各自快照对 ai_usage_daily 扣两次；
  // 串行化后每次快照都反映上一次清理的结果。
  runExclusiveCleanup<T>(task: () => Promise<T>): Promise<T> {
    const run = this.cleanupChain.then(task, task)
    this.cleanupChain = run.then(() => undefined, () => undefined)
    return run
  }

  cleanup({ before = 0, filters = {}, dryRun = false, all = false }: { before?: number; filters?: LogFilters; dryRun?: boolean; all?: boolean } = {}): Promise<UnknownRecord> {
    return this.runExclusiveCleanup(async () => {
      const flushed = await this.flushBarrier(1500)
      if (sqliteClient.status.available && !flushed) throw new Error("日志队列仍在刷新，请稍后重试清理")
      this.managementPaused = true
      try {
        return await this.cleanupAfterBarrier({ before, filters, dryRun, all })
      } finally {
        this.managementPaused = false
      }
    })
  }

  async cleanupAfterBarrier({ before = 0, filters = {}, dryRun = false, all = false }: { before?: number; filters?: LogFilters; dryRun?: boolean; all?: boolean } = {}): Promise<UnknownRecord> {
    const cutoff = Number(before) || 0
    const where = this.buildRunWhere({ ...filters, before: cutoff })
    if (!where.sql && !all) throw new Error("清理日志需要提供 before、筛选条件或 all=true")
    // 日汇总触发器只做累加；除“纯 before 截断”外的筛选删除都要把被删终态调用同步扣减。
    const scopedFilters = !all
      && ["model", "purpose", "source", "userId", "groupId", "status", "query", "from", "to"].some(key => filters[key])
    // 带筛选/按日清理跳过最近 24 小时内仍在 running 的 run：删掉后其终态事件
    // 会重建父行并重新累计日汇总，形成“清理后复活”；更早的 running 视为崩溃残留照常清理。
    const runningCutoff = now() - 86400000
    const matchesCleanup = (row: LogRow): boolean => (all || this.matchesRun(row, filters, cutoff))
      && (all || !(String(row.status) === "running" && Number(row.started_at) >= runningCutoff))
    if (!sqliteClient.status.available) {
      const matches = [...this.memoryRuns.values()].filter(matchesCleanup)
      const ids = new Set(matches.map(row => row.id))
      const modelCalls = [...this.memoryModels.values()].filter(row => ids.has(String(row.run_id || ""))).length
      const toolCalls = [...this.memoryTools.values()].filter(row => ids.has(String(row.run_id || ""))).length
      if (!dryRun) {
        if (scopedFilters) {
          for (const row of this.memoryModels.values()) {
            if (!ids.has(String(row.run_id || "")) || !(Number(row.ended_at) > 0)) continue
            const key = `${dayOf(row.started_at)}|${row.model_name}|${row.purpose}`
            const daily = this.memoryDaily.get(key)
            if (!daily) continue
            daily.input = Math.max(0, daily.input - asInt(row.input_tokens))
            daily.output = Math.max(0, daily.output - asInt(row.output_tokens))
            daily.total = Math.max(0, daily.total - asInt(row.total_tokens))
            daily.estimated = Math.max(0, daily.estimated - asInt(row.estimated_input_tokens) - asInt(row.estimated_output_tokens))
            daily.cached = Math.max(0, daily.cached - asInt(row.cached_tokens))
            daily.reasoning = Math.max(0, daily.reasoning - asInt(row.reasoning_tokens))
            daily.durationMs = Math.max(0, daily.durationMs - asInt(row.duration_ms))
            daily.cost = Math.max(0, daily.cost - asNumber(row.estimated_cost))
            daily.failures = Math.max(0, daily.failures - (row.status === "ok" ? 0 : 1))
            daily.calls = Math.max(0, daily.calls - 1)
            if (!daily.calls) this.memoryDaily.delete(key)
          }
        }
        for (const id of ids) this.memoryRuns.delete(id)
        for (const [id, row] of this.memoryModels) if (ids.has(String(row.run_id || ""))) this.memoryModels.delete(id)
        for (const [id, row] of this.memorySnapshots) if (ids.has(String(row.run_id || ""))) this.memorySnapshots.delete(id)
        for (const [id, row] of this.memoryTools) if (ids.has(String(row.run_id || ""))) this.memoryTools.delete(id)
        this.removeQueuedRuns(ids)
        if (all) {
          this.memoryDaily.clear()
          this.memorySnapshots.clear()
        } else if (!scopedFilters && cutoff) {
          const cutoffDay = dayOf(cutoff)
          for (const [key, row] of this.memoryDaily) if (row.day < cutoffDay) this.memoryDaily.delete(key)
        }
      }
      return { dryRun, runs: matches.length, modelCalls, toolCalls, persistent: false }
    }
    const condition: { sql: string; params: unknown[] } = all
      ? { sql: "1=1", params: [] }
      : { sql: `${where.sql} AND NOT (status = 'running' AND started_at >= ?)`, params: [...where.params, runningCutoff] }
    const select = `SELECT COUNT(*) AS runs FROM ai_runs WHERE ${condition.sql}`
    const modelSelect = `SELECT COUNT(*) AS total FROM model_call_events WHERE run_id IN (SELECT id FROM ai_runs WHERE ${condition.sql})`
    const toolSelect = `SELECT COUNT(*) AS total FROM tool_call_events WHERE run_id IN (SELECT id FROM ai_runs WHERE ${condition.sql})`
    const counts = (await sqliteClient.transaction([
      { sql: select, params: condition.params, mode: "get" },
      { sql: modelSelect, params: condition.params, mode: "get" },
      { sql: toolSelect, params: condition.params, mode: "get" },
    ])).map(record)
    const result = { dryRun, runs: Number(counts[0]?.runs || 0), modelCalls: Number(counts[1]?.total || 0), toolCalls: Number(counts[2]?.total || 0), persistent: true }
    if (dryRun) return result
    const operations: SqlOperation[] = [
      // 先删 ai_runs：model/query 筛选的子查询依赖 model_call_events，必须在事件行还在时求值；
      // 事件行随 run 由外键 ON DELETE CASCADE 删除（connection.js 固定开启 foreign_keys）。
      // 旧顺序先删事件会让 runs 的子查询落空，被筛选的 run 永远删不掉。
      { sql: `DELETE FROM ai_runs WHERE ${condition.sql}`, params: condition.params },
    ]
    if (all) {
      operations.push({ sql: "DELETE FROM ai_usage_daily", params: [] })
    } else if (scopedFilters) {
      // cleanup() 已持有 flushBarrier + managementPaused，SELECT 与删除事务之间不会有新写入。
      const rollups = await sqliteClient.all<UnknownRecord>(
        `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', '+8 hours') AS day, model_name, purpose,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS total_tokens,
                SUM(estimated_input_tokens + estimated_output_tokens) AS estimated_tokens,
                SUM(cached_tokens) AS cached_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
                COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS failures,
                SUM(duration_ms) AS duration_ms, SUM(estimated_cost) AS estimated_cost
         FROM model_call_events
         WHERE ended_at > 0 AND run_id IN (SELECT id FROM ai_runs WHERE ${condition.sql})
         GROUP BY day, model_name, purpose`,
        condition.params,
      )
      for (const row of rollups) operations.push({
        sql: `UPDATE ai_usage_daily SET
                input_tokens=MAX(0, input_tokens - ?), output_tokens=MAX(0, output_tokens - ?),
                total_tokens=MAX(0, total_tokens - ?), estimated_tokens=MAX(0, estimated_tokens - ?),
                cached_tokens=MAX(0, cached_tokens - ?), reasoning_tokens=MAX(0, reasoning_tokens - ?),
                calls=MAX(0, calls - ?), failures=MAX(0, failures - ?),
                duration_ms=MAX(0, duration_ms - ?), estimated_cost=MAX(0, estimated_cost - ?)
              WHERE day=? AND model_name=? AND purpose=?`,
        params: [
          asInt(row.input_tokens), asInt(row.output_tokens), asInt(row.total_tokens), asInt(row.estimated_tokens),
          asInt(row.cached_tokens), asInt(row.reasoning_tokens), asInt(row.calls), asInt(row.failures),
          asInt(row.duration_ms), asNumber(row.estimated_cost), row.day, row.model_name, row.purpose,
        ],
      })
      if (rollups.length) operations.push({ sql: "DELETE FROM ai_usage_daily WHERE calls <= 0", params: [] })
    } else if (cutoff) {
      operations.push({ sql: "DELETE FROM ai_usage_daily WHERE day < ?", params: [dayOf(cutoff)] })
    }
    await sqliteClient.transaction(operations)
    const queuedIds = new Set([...this.memoryRuns.values()].filter(matchesCleanup).map(row => row.id))
    this.removeQueuedRuns(queuedIds)
    for (const id of queuedIds) this.memoryRuns.delete(id)
    for (const [id, row] of this.memoryModels) if (queuedIds.has(String(row.run_id || ""))) this.memoryModels.delete(id)
    for (const [id, row] of this.memorySnapshots) if (queuedIds.has(String(row.run_id || ""))) this.memorySnapshots.delete(id)
    for (const [id, row] of this.memoryTools) if (queuedIds.has(String(row.run_id || ""))) this.memoryTools.delete(id)
    if (all) {
      this.memoryDaily.clear()
      this.memorySnapshots.clear()
    } else if (cutoff && !scopedFilters) {
      const cutoffDay = dayOf(cutoff)
      for (const [key, row] of this.memoryDaily) if (row.day < cutoffDay) this.memoryDaily.delete(key)
    }
    return result
  }

  removeQueuedRuns(ids: Set<string> = new Set()): void {
    if (!ids.size) return
    this.detailQueue = this.detailQueue.filter(event => {
      const runId = String(event.kind === "run" ? event.row?.id : event.row?.run_id || "")
      return !ids.has(runId)
    })
    this.detailQueueBytes = this.detailQueue.reduce((total, event) => total + (Number(event.bytes) || detailEventBytes(event)), 0)
  }

  buildRunWhere({ before = 0, from = 0, to = 0, status = "", model = "", purpose = "", source = "", userId = "", groupId = "", query = "" }: LogFilters = {}): { sql: string; params: unknown[] } {
    const clauses = []
    const params = []
    if (before) { clauses.push("started_at < ?"); params.push(before) }
    if (from) { clauses.push("started_at >= ?"); params.push(from) }
    if (to) { clauses.push("started_at <= ?"); params.push(to) }
    if (status) { clauses.push("status = ?"); params.push(String(status)) }
    if (purpose) { clauses.push("purpose = ?"); params.push(String(purpose)) }
    if (source) { clauses.push("source = ?"); params.push(String(source)) }
    if (userId) { clauses.push("user_id = ?"); params.push(String(userId)) }
    if (groupId) { clauses.push("group_id = ?"); params.push(String(groupId)) }
    if (query) {
      const pattern = `%${String(query).slice(0, 80)}%`
      clauses.push("(conversation_key LIKE ? OR user_id LIKE ? OR group_id LIKE ? OR source LIKE ? OR purpose LIKE ? OR id IN (SELECT run_id FROM model_call_events WHERE input_text LIKE ?) OR id IN (SELECT run_id FROM tool_call_events WHERE tool_name LIKE ? OR source LIKE ? OR category LIKE ? OR arguments_json LIKE ? OR result_text LIKE ? OR error_message LIKE ?))")
      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
    }
    if (model) { clauses.push("id IN (SELECT run_id FROM model_call_events WHERE model_name = ?)"); params.push(String(model)) }
    return { sql: clauses.join(" AND "), params }
  }

  matchesRun(row: LogRow, filters: LogFilters = {}, before = 0): boolean {
    if (before && Number(row.started_at) >= before) return false
    if (filters.from && Number(row.started_at) < Number(filters.from)) return false
    if (filters.to && Number(row.started_at) > Number(filters.to)) return false
    for (const key of ["status", "purpose", "source"]) if (filters[key] && String(row[key]) !== String(filters[key])) return false
    if (filters.userId && String(row.user_id) !== String(filters.userId)) return false
    if (filters.groupId && String(row.group_id) !== String(filters.groupId)) return false
    if (filters.query && !`${row.conversation_key} ${row.user_id} ${row.group_id} ${row.source} ${row.purpose} ${[...this.memoryModels.values()].filter(item => item.run_id === row.id).map(item => item.input_text || "").join(" ")} ${[...this.memoryTools.values()].filter(item => item.run_id === row.id).map(item => `${item.tool_name} ${item.source} ${item.category} ${item.arguments_json} ${item.result_text} ${item.error_message}`).join(" ")}`.includes(String(filters.query))) return false
    if (filters.model && ![...this.memoryModels.values()].some(item => item.run_id === row.id && String(item.model_name) === String(filters.model))) return false
    return true
  }

  async summary(filters: LogFilters = {}): Promise<UnknownRecord> {
    const { from = 0, to = now() } = filters
    const start = Number(from) || now() - 86400000
    const end = Number(to) || now()
    const hasDetailFilters = ["status", "model", "purpose", "source", "userId", "groupId", "query"].some(key => Boolean(filters[key]))
    let rows: UnknownRecord[] = []
    let filteredRunWhere = null
    if (sqliteClient.status.available && hasDetailFilters) {
      filteredRunWhere = this.buildRunWhere({ ...filters, from: start, to: end })
      rows = await sqliteClient.all<UnknownRecord>(
        `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', '+8 hours') AS day,
                model_name, purpose,
                SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS total_tokens,
                SUM(estimated_input_tokens + estimated_output_tokens) AS estimated_tokens,
                SUM(cached_tokens) AS cached_tokens, SUM(reasoning_tokens) AS reasoning_tokens,
                COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 0 ELSE 1 END) AS failures,
                SUM(duration_ms) AS duration_ms, SUM(estimated_cost) AS estimated_cost
         FROM model_call_events
         WHERE ended_at > 0 AND run_id IN (SELECT id FROM ai_runs WHERE ${filteredRunWhere.sql})
         GROUP BY day, model_name, purpose ORDER BY day ASC`,
        filteredRunWhere.params,
      )
    } else if (sqliteClient.status.available) {
      rows = await sqliteClient.all<UnknownRecord>("SELECT day, model_name, purpose, input_tokens, output_tokens, total_tokens, estimated_tokens, cached_tokens, reasoning_tokens, calls, failures, duration_ms, estimated_cost FROM ai_usage_daily WHERE day >= ? AND day <= ? ORDER BY day ASC", [dayOf(start), dayOf(end)])
    } else if (hasDetailFilters) {
      const runIds = new Set([...this.memoryRuns.values()].filter(row => this.matchesRun(row, { ...filters, from: start, to: end })).map(row => row.id))
      rows = [...this.memoryModels.values()]
        .filter(row => runIds.has(String(row.run_id || "")) && isTerminal(row.status))
        .map(row => ({ ...row, day: dayOf(row.started_at), estimated_tokens: asInt(row.estimated_input_tokens) + asInt(row.estimated_output_tokens), calls: 1, failures: row.status === "ok" ? 0 : 1 }))
    }
    const merged = new Map<string, SummaryRow>()
    const add = (row: UnknownRecord): void => {
      const day = String(row.day || "")
      const modelName = String(row.model_name || "")
      const purposeName = String(row.purpose || "")
      const key = `${day}|${modelName}|${purposeName}`
      const current: SummaryRow = merged.get(key) || { day, model_name: modelName, purpose: purposeName, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, calls: 0, failures: 0, duration_ms: 0, estimated_cost: 0 }
      const numeric = current as unknown as Record<string, number>
      for (const field of ["input_tokens", "output_tokens", "total_tokens", "estimated_tokens", "cached_tokens", "reasoning_tokens", "calls", "failures", "duration_ms", "estimated_cost"]) numeric[field] = asNumber(numeric[field]) + asNumber(row[field])
      merged.set(key, current)
    }
    rows.forEach(add)
    if (!sqliteClient.status.available && !hasDetailFilters) {
      for (const row of this.memoryDaily.values()) if (row.day >= dayOf(start) && row.day <= dayOf(end)) add({ day: row.day, model_name: row.modelName, purpose: row.purpose, input_tokens: row.input, output_tokens: row.output, total_tokens: row.total, estimated_tokens: row.estimated, cached_tokens: row.cached, reasoning_tokens: row.reasoning, calls: row.calls, failures: row.failures, duration_ms: row.durationMs, estimated_cost: row.cost })
    }
    const daily = new Map<string, SummaryMetrics & { day: string }>()
    const models = new Map<string, SummaryMetrics & { name: string }>()
    const purposes = new Map<string, SummaryMetrics & { name: string }>()
    const totals: SummaryMetrics = { input: 0, output: 0, total: 0, estimated: 0, cached: 0, reasoning: 0, calls: 0, failures: 0, durationMs: 0, cost: 0 }
    for (const row of merged.values()) {
      const normalized: SummaryMetrics = { input: row.input_tokens, output: row.output_tokens, total: row.total_tokens || row.input_tokens + row.output_tokens, estimated: row.estimated_tokens, cached: row.cached_tokens, reasoning: row.reasoning_tokens, calls: row.calls, failures: row.failures, durationMs: row.duration_ms, cost: row.estimated_cost }
      const day = daily.get(row.day) || { day: row.day, input: 0, output: 0, total: 0, estimated: 0, cached: 0, reasoning: 0, calls: 0, failures: 0, durationMs: 0, cost: 0 }
      const model = models.get(row.model_name) || { name: row.model_name, input: 0, output: 0, total: 0, estimated: 0, cached: 0, reasoning: 0, calls: 0, failures: 0, durationMs: 0, cost: 0 }
      const purpose = purposes.get(row.purpose) || { name: row.purpose, input: 0, output: 0, total: 0, estimated: 0, cached: 0, reasoning: 0, calls: 0, failures: 0, durationMs: 0, cost: 0 }
      for (const target of [day, model, purpose, totals]) {
        const numericTarget = target as unknown as Record<string, number>
        for (const field of ["input", "output", "total", "estimated", "cached", "reasoning", "calls", "failures", "durationMs"]) numericTarget[field] = asNumber(numericTarget[field]) + asNumber(normalized[field as keyof SummaryMetrics])
        numericTarget.cost = asNumber(numericTarget.cost) + asNumber(normalized.cost)
      }
      daily.set(row.day, day); models.set(row.model_name, model); purposes.set(row.purpose, purpose)
    }
    return {
      range: { from: start, to: end },
      totals: { ...totals, currency: COST_CURRENCY },
      daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
      models: [...models.values()].sort((a, b) => b.total - a.total),
      purposes: [...purposes.values()].sort((a, b) => b.total - a.total),
      persistence: { available: Boolean(sqliteClient.status.available), queued: this.detailQueue.length, queuedBytes: this.detailQueueBytes, droppedEvents: this.droppedEvents, lastFlushAt: this.lastFlushAt ? new Date(this.lastFlushAt).toISOString() : "", lastError: this.lastError },
    }
  }

  async listRuns(filters: LogFilters = {}): Promise<UnknownRecord> {
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 50))
    const cursor = decodeCursor(filters.cursor)
    if (!sqliteClient.status.available) {
      const rows = [...this.memoryRuns.values()].filter(row => this.matchesRun(row, filters)).sort((a, b) => b.started_at - a.started_at || String(b.id).localeCompare(String(a.id)))
      const filtered = cursor ? rows.filter(row => row.started_at < cursor.startedAt || (row.started_at === cursor.startedAt && row.id < cursor.id)) : rows
      const selected = filtered.slice(0, limit)
      const models = [...this.memoryModels.values()]
      return {
        items: selected.map(row => this.publicRunSummary(row, modelSummary(models.filter(model => model.run_id === row.id)))),
        nextCursor: filtered.length > limit ? encodeCursor({ startedAt: filtered[limit - 1].started_at, id: filtered[limit - 1].id }) : "",
        persistence: false,
      }
    }
    const where = this.buildRunWhere(filters)
    const clauses = where.sql ? [where.sql] : []
    const params = [...where.params]
    if (cursor) { clauses.push("(started_at < ? OR (started_at = ? AND id < ?))"); params.push(Number(cursor.startedAt), Number(cursor.startedAt), String(cursor.id)) }
    // 列表只返回精简字段；额外读取 metadata_json 仅为提取失败 message，
    // publicRunSummary 会把元数据本身留在服务端，不把它扩散到列表响应。
    const sql = `SELECT ${[...RUN_LIST_COLUMNS, "metadata_json"].join(", ")} FROM ai_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ?`
    params.push(limit + 1)
    const rows = await sqliteClient.all<LogRow>(sql, params)
    const selected = rows.slice(0, limit)
    const ids = selected.map(row => String(row.id || "")).filter(Boolean)
    const modelsByRun = new Map<string, LogRow[]>()
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",")
      const models = await sqliteClient.all<LogRow>(
        `SELECT id, run_id, model_name, adapter, metadata_json FROM model_call_events WHERE run_id IN (${placeholders}) ORDER BY sequence ASC, started_at ASC, id ASC`,
        ids,
      )
      for (const model of models) {
        const runId = String(model.run_id || "")
        modelsByRun.set(runId, [...(modelsByRun.get(runId) || []), model])
      }
    }
    return {
      items: selected.map(row => this.publicRunSummary(row, modelSummary(modelsByRun.get(String(row.id || "")) || []))),
      nextCursor: rows.length > limit ? encodeCursor({ startedAt: rows[limit - 1].started_at, id: rows[limit - 1].id }) : "",
      persistence: true,
    }
  }

  async getRun(id: unknown): Promise<UnknownRecord | null> {
    const key = String(id || "")
    if (!key) throw new Error("缺少运行 ID")
    if (!sqliteClient.status.available) {
      const run = this.memoryRuns.get(key)
      if (!run) return null
      const modelRows = [...this.memoryModels.values()].filter(row => row.run_id === key)
      return {
        run: { ...this.publicRun(run), ...modelSummary(modelRows) },
        modelCalls: modelRows.map(row => this.publicModel(row, run)),
        toolCalls: [...this.memoryTools.values()].filter(row => row.run_id === key).map(row => this.publicTool(row)),
        childRuns: [...this.memoryRuns.values()].filter(row => row.parent_run_id === key).map(row => this.publicRun(row)),
        persistence: false,
      }
    }
    const run = await sqliteClient.get<LogRow>("SELECT * FROM ai_runs WHERE id=?", [key])
    if (!run) return null
    const modelCalls = await sqliteClient.all<LogRow>("SELECT * FROM model_call_events WHERE run_id=? ORDER BY sequence ASC, started_at ASC", [key])
    const toolCalls = await sqliteClient.all<LogRow>("SELECT * FROM tool_call_events WHERE run_id=? ORDER BY round ASC, call_index ASC, started_at ASC", [key])
    const childRuns = await sqliteClient.all<LogRow>("SELECT * FROM ai_runs WHERE parent_run_id=? ORDER BY started_at ASC, id ASC", [key])
    return { run: { ...this.publicRun(run), ...modelSummary(modelCalls) }, modelCalls: modelCalls.map(row => this.publicModel(row, run)), toolCalls: toolCalls.map(row => this.publicTool(row)), childRuns: childRuns.map(row => this.publicRun(row)), persistence: true }
  }

  async getModelCallDetail(id: unknown): Promise<UnknownRecord | null> {
    const key = String(id || "")
    if (!key) throw new Error("缺少模型调用 ID")
    let model = this.memoryModels.get(key) || null
    let snapshot = this.memorySnapshots.get(key) || null
    if (sqliteClient.status.available) {
      model = await sqliteClient.get<LogRow>("SELECT * FROM model_call_events WHERE id=?", [key]) || model
      snapshot = await sqliteClient.get<LogRow>("SELECT * FROM model_call_snapshots WHERE model_call_id=?", [key]) || snapshot
    }
    if (!model) return null
    let run: LogRow | null = this.memoryRuns.get(String(model.run_id || "")) || null
    if (sqliteClient.status.available && model.run_id) run = await sqliteClient.get<LogRow>("SELECT * FROM ai_runs WHERE id=?", [model.run_id]) || run
    return {
      modelCall: this.publicModel(model, run),
      snapshot: snapshot ? this.publicSnapshot(snapshot) : null,
      available: Boolean(snapshot),
      persistence: Boolean(sqliteClient.status.available),
    }
  }

  async getConversation(runId: unknown): Promise<UnknownRecord | null> {
    const key = String(runId || "")
    if (!key) throw new Error("缺少运行 ID")
    let anchor = this.memoryRuns.get(key) || null
    if (sqliteClient.status.available) anchor = await sqliteClient.get<LogRow>("SELECT * FROM ai_runs WHERE id=?", [key]) || anchor
    if (!anchor) return null
    const conversationKey = String(anchor.conversation_key || "")
    if (!conversationKey) return { runId: key, conversationKey: "", items: [], available: false, persistence: Boolean(sqliteClient.status.available) }

    const rows = new Map<string, LogRow>()
    if (sqliteClient.status.available) {
      const persisted = await sqliteClient.all<LogRow>(
        "SELECT id, source, purpose, conversation_key, scope_type, user_id, group_id, status, started_at, ended_at, duration_ms, response_text, prompt_text, model_calls, tool_calls, failed_tools, total_tokens FROM ai_runs WHERE conversation_key=? AND (parent_run_id='' OR parent_run_id IS NULL) ORDER BY started_at ASC, id ASC",
        [conversationKey],
      )
      for (const row of persisted) rows.set(row.id, row)
    }
    for (const row of this.memoryRuns.values()) if (String(row.conversation_key || "") === conversationKey && !String(row.parent_run_id || "")) rows.set(row.id, row)
    if (!rows.has(key) && !String(anchor.parent_run_id || "")) rows.set(key, anchor)

    const runRows = [...rows.values()].sort((a, b) => Number(a.started_at || 0) - Number(b.started_at || 0) || String(a.id).localeCompare(String(b.id)))
    const ids = runRows.map(row => String(row.id || "")).filter(Boolean)
    const idSet = new Set(ids)
    const modelIds = new Map<string, string[]>()
    for (const row of this.memoryModels.values()) {
      const runKey = String(row.run_id || "")
      if (idSet.has(runKey)) modelIds.set(runKey, [...(modelIds.get(runKey) || []), String(row.id)])
    }
    if (sqliteClient.status.available && ids.length) {
      const persistedModels = await sqliteClient.all<LogRow>(
        "SELECT model_call_events.id, model_call_events.run_id FROM model_call_events INNER JOIN ai_runs ON ai_runs.id=model_call_events.run_id WHERE ai_runs.conversation_key=? AND (ai_runs.parent_run_id='' OR ai_runs.parent_run_id IS NULL) ORDER BY model_call_events.started_at ASC, model_call_events.sequence ASC, model_call_events.id ASC",
        [conversationKey],
      )
      for (const row of persistedModels) {
        const runKey = String(row.run_id || "")
        const current = modelIds.get(runKey) || []
        if (!current.includes(String(row.id))) current.push(String(row.id))
        modelIds.set(runKey, current)
      }
    }
    return {
      runId: key,
      conversationKey,
      session: {
        key: conversationKey,
        scope_type: String(anchor.scope_type || runRows[0]?.scope_type || ""),
        user_id: String(anchor.user_id || runRows[0]?.user_id || ""),
        group_id: String(anchor.group_id || runRows[0]?.group_id || ""),
        source: String(runRows[0]?.source || anchor.source || ""),
        purpose: String(runRows[0]?.purpose || anchor.purpose || ""),
        started_at: Number(runRows[0]?.started_at || anchor.started_at || 0),
        ended_at: Number(runRows.at(-1)?.ended_at || 0),
        turn_count: runRows.length,
      },
      available: true,
      items: runRows.map(row => {
        const promptText = redactText(row.prompt_text || "", 30000)
        const responseText = responseForLog({ source: row.source, purpose: row.purpose }, row.response_text || "")
        return {
          id: row.id,
          source: row.source || "",
          purpose: row.purpose || "",
          status: row.status || "",
          started_at: row.started_at || 0,
          ended_at: row.ended_at || 0,
          duration_ms: row.duration_ms || 0,
          // 会话索引只承担定位职责；完整正文由选中轮次的 /api/logs/runs/:id 单独返回。
          prompt_text: promptText.length > 240 ? `${promptText.slice(0, 240)}…` : promptText,
          response_text: responseText.length > 240 ? `${responseText.slice(0, 240)}…` : responseText,
          prompt_chars: promptText.length,
          response_chars: responseText.length,
          model_calls: asInt(row.model_calls),
          tool_calls: asInt(row.tool_calls),
          failed_tools: asInt(row.failed_tools),
          total_tokens: asInt(row.total_tokens),
          model_call_ids: [...new Set(modelIds.get(String(row.id)) || [])],
        }
      }),
      persistence: Boolean(sqliteClient.status.available),
    }
  }

  publicRun(row: LogRow): UnknownRecord {
    const result: UnknownRecord = { ...row }
    const metadata = parseJson(result.metadata_json)
    result.metadata = metadata
    delete result.metadata_json
    if (typeof metadata.error === "string" && metadata.error) result.error_message = metadata.error
    if (metadata.errorDetails && typeof metadata.errorDetails === "object") result.error_details = metadata.errorDetails
    if (row.conversation_key) result.session_id = row.conversation_key
    return result
  }

  publicRunSummary(row: LogRow, summary: UnknownRecord = {}): UnknownRecord {
    const result = Object.fromEntries(RUN_LIST_COLUMNS.map(key => [key, row?.[key]]))
    const metadata = parseJson(row?.metadata_json)
    const error = String(row?.error_message || metadata.error || "")
    if (error) result.error_message = error
    if (row?.conversation_key) result.session_id = row.conversation_key
    Object.assign(result, summary)
    return result
  }

  publicModel(row: LogRow = { id: "", started_at: 0, ended_at: 0 }, run: LogRow | null = null): UnknownRecord {
    const metadata = parseJson(row.metadata_json)
    const route = record(metadata.route)
    const fallbackActualModel = {
      id: row.model_name || "",
      name: row.model_name || "",
      model: row.model_identifier || "",
      provider: row.provider_name || "",
      adapter: row.adapter || "",
    }
    const protocol = String(metadata.protocol || protocolForAdapter(row.adapter))
    const stream = Object.hasOwn(metadata, "stream") ? metadata.stream === true : null
    const sessionId = String(run?.conversation_key || row.conversation_key || "")
    return {
      ...row,
      metadata,
      protocol,
      stream,
      ...(sessionId ? { session_id: sessionId, conversation_key: sessionId } : {}),
      error_message: row.error_message || (typeof metadata.error === "string" ? metadata.error : ""),
      error_details: metadata.errorDetails && typeof metadata.errorDetails === "object" ? metadata.errorDetails : {},
      response_text: typeof metadata.responseText === "string" ? metadata.responseText : "",
      stop_reason: typeof metadata.stopReason === "string" ? metadata.stopReason : "unknown",
      route,
      available_models: Array.isArray(route.availableModels) ? route.availableModels : [],
      actual_model: route.actualModel && typeof route.actualModel === "object" ? route.actualModel : fallbackActualModel,
      // toolCount 是本次请求提供给模型的工具数，toolCalls 是模型响应里实际返回的调用数；
      // 两者分开返回，避免详情页把“可用工具”误读成“已执行工具”。
      available_tool_count: asInt(metadata.toolCount),
      context_message_count: asInt(metadata.messageCount),
      response_tool_call_count: asInt(metadata.toolCalls),
      hosted_tool_calls: Array.isArray(metadata.hostedToolCalls) ? metadata.hostedToolCalls : [],
      hosted_tool_call_count: Array.isArray(metadata.hostedToolCalls) ? metadata.hostedToolCalls.length : 0,
      responses_state_recovery: record(metadata.responsesStateRecovery),
    }
  }

  publicSnapshot(row: LogRow = { id: "", started_at: 0, ended_at: 0 }): UnknownRecord {
    const messages = parseJsonValue(row.messages_json, [])
    const tools = parseJsonValue(row.tools_json, [])
    const request = parseJson(row.request_json)
    return {
      model_call_id: row.model_call_id || row.id,
      run_id: row.run_id || "",
      sequence: asInt(row.sequence),
      operation: row.operation || "chat",
      messages: Array.isArray(messages) ? messages : [],
      tools: Array.isArray(tools) ? tools : [],
      request,
      message_count: asInt(row.message_count),
      tool_count: asInt(row.tool_count),
      context_chars: asInt(row.context_chars),
      tool_chars: asInt(row.tool_chars),
      truncated: Boolean(row.truncated),
      redaction_version: row.redaction_version || "v1",
      captured_at: row.captured_at || 0,
      updated_at: row.updated_at || 0,
    }
  }

  publicTool(row: LogRow = { id: "", started_at: 0, ended_at: 0 }): UnknownRecord {
    const result: UnknownRecord = { ...row, requires_final_reply: Boolean(row.requires_final_reply) }
    for (const key of ["arguments_json", "metadata_json"]) {
      const target = key.replace("_json", "")
      try { result[target] = JSON.parse(String(result[key] || "{}")) } catch { result[target] = {} }
      delete result[key]
    }
    const metadata = record(result.metadata)
    result.deduplicated = metadata.deduplicated === true
    for (const key of ["operationId", "operationFamily", "effect", "repeatPolicy", "retryPolicy", "dispatched", "decision", "guardCode", "attempt", "requestedCount", "executedCount", "completedCount", "remainingCount", "retryAllowed", "resultFingerprint"]) {
      const value = metadata[key]
      if (value !== undefined) result[key] = value
    }
    return result
  }

  cleanupExpired(): Promise<UnknownRecord> {
    // 保留清理自身复用进行中的 promise 去重；执行体同样排进清理串行链，
    // 保证不与带筛选清理交错读写同一批行。
    if (this.cleanupPromise) return this.cleanupPromise
    const task = this.runExclusiveCleanup(() => this.performCleanupExpired())
    const wrapped = task.finally(() => {
      if (this.cleanupPromise === wrapped) this.cleanupPromise = null
    })
    this.cleanupPromise = wrapped
    return wrapped
  }

  async performCleanupExpired(): Promise<UnknownRecord> {
    const current = now()
    const settings = this.settings || retention()
    const detailCutoff = current - settings.detailDays * 86400000
    const aggregateCutoff = current - settings.aggregateDays * 86400000
    const expiredRunIds = new Set([...this.memoryRuns.values()].filter(row => Number(row.started_at || 0) < detailCutoff).map(row => row.id))
    for (const id of expiredRunIds) this.memoryRuns.delete(id)
    for (const [id, row] of this.memoryModels) if (expiredRunIds.has(String(row.run_id || "")) || Number(row.started_at || 0) < detailCutoff) this.memoryModels.delete(id)
    for (const [id, row] of this.memorySnapshots) if (expiredRunIds.has(String(row.run_id || "")) || Number(row.started_at || row.captured_at || 0) < detailCutoff) this.memorySnapshots.delete(id)
    for (const [id, row] of this.memoryTools) if (expiredRunIds.has(String(row.run_id || "")) || Number(row.started_at || 0) < detailCutoff) this.memoryTools.delete(id)
    this.removeQueuedRuns(expiredRunIds)
    this.detailQueue = this.detailQueue.filter(event => Number(event.row?.started_at || current) >= detailCutoff)
    this.detailQueueBytes = this.detailQueue.reduce((total, event) => total + (Number(event.bytes) || detailEventBytes(event)), 0)
    const aggregateDay = dayOf(aggregateCutoff)
    for (const [key, row] of this.memoryDaily) if (row.day < aggregateDay) this.memoryDaily.delete(key)
    if (!sqliteClient.status.available) return { persistent: false, runs: expiredRunIds.size }
    const result = await sqliteClient.transaction([
      { sql: "DELETE FROM ai_runs WHERE started_at < ?", params: [detailCutoff] },
      { sql: "DELETE FROM ai_usage_daily WHERE day < ?", params: [aggregateDay] },
    ])
    return { persistent: true, result }
  }

  stats(): UnknownRecord {
    return { enabled: this.enabled, queueLength: this.detailQueue.length, queueBytes: this.detailQueueBytes, droppedEvents: this.droppedEvents, lastFlushAt: this.lastFlushAt, lastError: this.lastError, persistenceAvailable: Boolean(sqliteClient.status.available) }
  }
}

export const modelLogStore = new ModelLogStore()
