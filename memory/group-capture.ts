import crypto from "node:crypto"
import { configStore } from "../config/store.js"
import { estimateTokens } from "../core/chat/token-budget.js"
import { isCommandMessage } from "../core/message/command-prefixes.js"
import { stripMessageCodes } from "../core/message/message-context.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { runIsolatedModelTask } from "../models/isolated-task.js"
import { expiryFor } from "./decay.js"
import { memoryRepository } from "./repository.js"
import { sqliteMemoryStore } from "./sqlite-store.js"
import { validateMemoryWrite } from "./write-policy.js"

const DAY = 24 * 60 * 60 * 1000
const EXTRACTOR_VERSION = "group-memory-v4-daily"
const SCOPE_TYPES = new Set(["group"])
const REDACTED_KEYS = /(?:url|path|base64|cookie|authorization|token|secret|password|credential|image|record|video|data)$/i
const SAFE_META_KEYS = new Set([
  "id", "name", "title", "summary", "description", "size", "file_id", "forward_id", "emoji_id",
  "face_id", "user_id", "qq", "seq", "message_id", "platform", "music_id", "latitude", "longitude",
])

type UnknownRecord = Record<string, unknown>

interface GroupEvent extends UnknownRecord {
  isGroup?: boolean
  message_type?: unknown
  detail_type?: unknown
  group_id?: unknown
  user_id?: unknown
  self_id?: unknown
  time?: unknown
  timestamp?: unknown
  message_id?: unknown
  messageId?: unknown
  id?: unknown
  raw_message?: unknown
  msg?: unknown
  message?: unknown
  sender?: UnknownRecord
  bot?: UnknownRecord
}

interface GroupPolicy extends UnknownRecord {
  scopeType: string
  scopeId: string
  enabled: boolean
  retentionDays: number
  tokenLimit: number
  promptTemplate: string
  promptTemplateOverride: string
  usesDefaultPrompt: boolean
  usesBuiltInPrompt: boolean
  modelName: string
  maxTokens: number
  minConfidence: number
  retrievalResultLimit: number
  lastDailyEnd: number
  overrides: UnknownRecord
}

interface NormalizedEvent extends UnknownRecord {
  id: string
  scopeType: string
  scopeId: string
  messageId: string
  senderId: string
  senderName: string
  senderNickname: string
  senderCard: string
  senderRole: string
  sentAt: number
  text: string
  segments: UnknownRecord[]
  contentHash: string
  isCommand: number
  expiresAt: number
}

interface FactClaim extends UnknownRecord {
  key: string
  value: string
  label?: string
}

interface MemoryScope extends UnknownRecord {
  scopeType: string
  ownerId: string
  groupId: string
}

interface Candidate extends UnknownRecord {
  operation?: string
  scope?: string
  kind?: string
  text?: string
  subjectId?: string
  speakerId?: string
  sensitivity?: string
  factKey?: string
  factValue?: string
  confidence?: unknown
  importance?: unknown
  validTo?: unknown
  evidenceMessageIds?: unknown
  evidenceIds?: string[]
  evidence?: UnknownRecord[]
}

interface ExtractionOptions extends UnknownRecord {
  isCurrent?: () => boolean
}

interface PartitionResult {
  chunks: UnknownRecord[][]
  skipped: UnknownRecord[]
  estimatedTokens: number
}

interface DailyWindowResult extends UnknownRecord {
  rows: UnknownRecord[]
  partition: PartitionResult
  queued: boolean
}

interface WindowQueueSummary extends UnknownRecord {
  queued: number
  alreadyQueued: number
  skippedEmpty: number
  messageCount: number
  estimatedInputTokens: number
  estimatedModelCalls: number
  queuedWindowStarts: number[]
  alreadyQueuedWindowStarts: number[]
  skippedEmptyWindowStarts: number[]
}

interface JsonResult extends UnknownRecord {
  items?: unknown
  candidates?: unknown
  memoryResultCount?: unknown
  ignoredResultCount?: unknown
  modelCallCount?: unknown
  messageCount?: unknown
  estimatedInputTokens?: unknown
  truncated?: unknown
  omittedItemCount?: unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

export const DEFAULT_GROUP_MEMORY_PROMPT = [
  "任务：从群聊原文中提炼以后仍有帮助、可以独立理解的原子记忆。不要总结聊天过程，也不要保存原句拼接。没有合格事实时返回空 candidates。",
  "先为每条候选选择且只选择一种记忆作用域：",
  "1. user（个人全局记忆）：用户本人明确自述、脱离当前群仍成立的稳定个人事实。适合姓名/昵称、性别或称谓、生日或带日期的年龄、长期兴趣与偏好、职业/学习方向、稳定习惯和交流偏好。subjectId 与 speakerId 都必须是该用户 QQ。",
  "2. user_group（个人群记忆）：只在当前群有意义的个人事实，例如本群昵称、群内角色或职责、与本群成员的关系、本群项目与任务、群内约定下的偏好。不能确定是否适合跨群使用的个人事实，默认放这里。subjectId 与 speakerId 都必须是该用户 QQ。",
  "3. group（群记忆）：属于整个群的规则、共同计划、公开决定、群主题和共同经历。应由群主/管理员明确宣布，或至少两名不同成员的消息共同支持；subjectId 留空。单个成员自己的偏好、身份或任务不能写成群记忆。",
  "作用域与内容类型是两回事。kind 只能从 identity、preference、relationship、plan、group_rule、experience、episode 中选择；episode 是有时效的事件类型，不是第四种作用域，并且只记录事件结论。",
  "证据规则：只依据本批输入中的文字和消息 ID。个人事实必须来自本人直接陈述；他人转述、猜测、玩笑、角色扮演、反问、机器人回复、纯指令和来源不明的转发均不能成为被提及者的确定事实。不要从昵称、头像或语气猜测性别、年龄或关系。",
  "拆分规则：一条候选只表达一个可独立更新的事实。‘我是男的，25 岁，喜欢咖啡’必须拆为三条。text 用第三人称写简洁结论，不包含聊天过程；同一事实只输出一次，不要同时换句话重复。",
  "撤回规则：仅当用户本人明确否定或撤回自己既有的事实（如‘我不喝咖啡了’‘别再叫我玉玉’）时，输出 operation 为 retract 的候选：factKey 填被撤回的事实槽位，factValue 可填被否定的旧值或留空，text 用第三人称写撤回结论，evidenceMessageIds 指向那条否定消息。普通新事实一律用 add（或省略 operation），不要用 retract。",
  "键值规则：factKey 表示稳定的事实槽位，factValue 表示用于去重和修订的简短规范值。优先使用 identity.name、identity.nickname、identity.gender、identity.pronouns、identity.birth_date、identity.age、profile.occupation、profile.education、preference.<topic>、communication.style、group_role.<role>、relationship.<person_or_role>、plan.<topic>、group.rule.<topic>、group.event.<topic>。factKey 必须使用小写英文、数字、点或下划线，不得包含具体取值、中文或整句话。",
  "称呼规则：text 一律用“用户”指代本人，不要把昵称或群名片写死在事实文本里；平台昵称与群名片由系统自动维护（identity.qq_nickname、identity.group_card），不要为它们输出候选。只有用户明确表达的称呼偏好（如“以后叫我小玉”）才输出 identity.nickname。",
  "时间规则：年龄写成‘用户于 YYYY-MM-DD 自述为 N 岁’，validTo 不晚于证据日期一年后。计划、临时状态、阶段性任务和事件必须填写合理的 validTo；生日、姓名、性别、长期偏好等稳定事实没有明确失效时间时可留空。",
  "普通个人资料可以记录：姓名、昵称、性别、称谓、年龄、生日、爱好、喜欢与不喜欢、职业、学习方向和一般关系。只忽略可直接造成风险的高度敏感信息：密码、验证码、Token/API Key、Cookie、登录凭证、银行卡或支付信息、身份证件号、完整手机号和精确住址。若消息同时含有普通事实与高度敏感字段，只丢弃敏感字段。",
  "置信度建议：本人清晰自述或管理员明确公告为 0.85–0.98；上下文明确但表述较弱为 0.70–0.84；低于 0.70、存在歧义或需要推断时不要输出。importance 只表示未来对话价值，不表示置信度。",
  "示例 A：[m1] 10001：我叫玉玉，我是男的，今年25岁，平时喜欢手冲咖啡。输出 4 条 user：identity.nickname=玉玉、identity.gender=male、identity.age=25、preference.coffee=hand_brew；年龄带证据日期和 validTo。",
  "示例 B：[m2] 10001：我在这个群负责每周发布版本。输出 user_group：group_role.release=weekly_release；不要提升为 user，也不要写成 group。",
  "示例 C：群主宣布‘以后每周一晚八点开例会’，或多名成员确认该安排。输出 group：group.rule.weekly_meeting=monday_20_00。",
  "示例 D：10001 说‘听说 10002 是女生’。不要输出 10002 的性别记忆。",
].join("\n")

function now(): number { return Date.now() }
function hash(value: unknown): string { return crypto.createHash("sha256").update(String(value || "")).digest("hex") }
function id(): string { return crypto.randomUUID() }
function cleanText(value: unknown = "", max = 8000): string { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max) }
function cleanPrompt(value: unknown = "", max = 12000): string { return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, max) }
function policyPrompt(value: unknown = ""): string {
  return cleanPrompt(value) || DEFAULT_GROUP_MEMORY_PROMPT
}
function number(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}
// STRICT 表的 INTEGER 列不接受小数，持久化前必须取整。
function integer(value: unknown, fallback: number, min: number, max: number): number { return Math.round(number(value, fallback, min, max)) }
function parseJson<T = unknown>(value: unknown, fallback: T = [] as T): T { try { return value ? JSON.parse(String(value)) as T : fallback } catch { return fallback } }
const EXTRACTION_RESULT_MAX_CHARS = 200000
export function serializeExtractionResult(value: unknown = {}, maxChars = EXTRACTION_RESULT_MAX_CHARS): string {
  const limit = Math.max(2, Math.floor(Number(maxChars) || EXTRACTION_RESULT_MAX_CHARS))
  const source = record(value)
  const items = records(source.items)
  // 日历摘要不能为了统计结果数而下发完整 result_json；在写入时同时保存两类计数，
  // 即使超长结果被裁剪，后续仍能准确区分“形成记忆”和“提炼无结果”。
  const memoryResultCount = Number.isFinite(Number(source.memoryResultCount))
    ? Math.max(0, Math.round(Number(source.memoryResultCount)))
    : items.filter(item => item?.action !== "ignored").length
  const ignoredResultCount = Number.isFinite(Number(source.ignoredResultCount))
    ? Math.max(0, Math.round(Number(source.ignoredResultCount)))
    : items.filter(item => item?.action === "ignored").length
  const summary: UnknownRecord = { ...source, memoryResultCount, ignoredResultCount }
  const full = JSON.stringify({ ...summary, items, omittedItemCount: 0, truncated: false })
  if (full.length <= limit) return full
  const base = JSON.stringify({ ...summary, items: [], omittedItemCount: items.length, truncated: true })
  if (base.length > limit) {
    const minimal = JSON.stringify({ items: [], memoryResultCount, ignoredResultCount, omittedItemCount: items.length, truncated: true })
    return minimal.length <= limit ? minimal : "{}"
  }
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = JSON.stringify({ ...summary, items: items.slice(0, middle), omittedItemCount: items.length - middle, truncated: middle < items.length })
    if (candidate.length <= limit) low = middle
    else high = middle - 1
  }
  return JSON.stringify({
    ...summary,
    items: items.slice(0, low),
    omittedItemCount: items.length - low,
    truncated: low < items.length,
  })
}
function groupConfig(): UnknownRecord {
  return record(record(configStore.get()).memory && record(record(configStore.get()).memory).groupCapture)
}
function policyDefaults(config: UnknownRecord = groupConfig()): {
  retentionDays: number
  tokenLimit: number
  promptTemplate: string
  modelName: string
  maxTokens: number
  minConfidence: number
  retrievalResultLimit: number
} {
  const consolidation = record(config.consolidation)
  const retrieval = record(record(record(configStore.get()).memory).retrieval)
  return {
    retentionDays: integer(config.defaultRetentionDays, 30, 0, 100000000),
    tokenLimit: integer(config.defaultTokenLimit, 30000, 256, 60000),
    promptTemplate: policyPrompt(config.promptTemplate || ""),
    modelName: cleanText(consolidation.modelName || "", 120),
    maxTokens: integer(consolidation.maxTokens, 4096, 256, 65536),
    minConfidence: number(consolidation.minConfidence, 0.7, 0, 1),
    retrievalResultLimit: integer(retrieval.resultLimit, 3, 1, 20),
  }
}
function retentionDays(config: UnknownRecord = groupConfig()): number { return policyDefaults(config).retentionDays }
function normalizeScopeType(value: unknown = ""): string { return SCOPE_TYPES.has(String(value || "")) ? String(value) : "" }
function historyRows(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return records(value)
  if (!value || typeof value !== "object") return []
  const source = record(value)
  for (const key of ["messages", "history", "data", "records"]) {
    if (Array.isArray(source[key])) return records(source[key])
  }
  return []
}
function isGroupEvent(e: GroupEvent = {}) { return Boolean(e.isGroup || e.message_type === "group" || e.detail_type === "group") }
function sentAt(e: GroupEvent = {}): number {
  const value = Number(e.time || e.timestamp || 0)
  if (!value) return now()
  // 适配器可能给出小数秒时间戳；STRICT 的 sent_at 是 INTEGER 列，必须取整。
  return Math.round(value > 100000000000 ? value : value * 1000)
}
function eventSenderId(e: GroupEvent = {}): string { return String(e.user_id || record(e.sender).user_id || "").trim() }
function eventSenderName(e: GroupEvent = {}): string {
  const sender = record(e.sender)
  return cleanText(sender.card || sender.nickname || sender.name || "", 120)
}
function eventMessageId(e: GroupEvent = {}): string { return String(e.message_id || e.messageId || e.id || "").trim() }
function isSelfMessage(e: GroupEvent = {}): boolean {
  const sender = eventSenderId(e)
  const self = String(e.self_id || e.bot?.uin || "").trim()
  return Boolean(sender && self && sender === self)
}

function safeMeta(data: unknown = {}, depth = 0): UnknownRecord {
  if (depth > 2 || !data || typeof data !== "object") return {}
  const result: UnknownRecord = {}
  for (const [key, value] of Object.entries(record(data))) {
    if (key === "type" || REDACTED_KEYS.test(key) || !SAFE_META_KEYS.has(key)) continue
    if (typeof value === "string") result[key] = cleanText(value, 300)
    else if (typeof value === "number" || typeof value === "boolean") result[key] = value
  }
  return result
}

function segmentData(segment: unknown = {}): UnknownRecord {
  const source = record(segment)
  return source.data && typeof source.data === "object" && !Array.isArray(source.data) ? record(source.data) : source
}

function normalizeSegments(e: GroupEvent = {}, config: UnknownRecord = groupConfig()): UnknownRecord[] {
  const maxSegments = number(config.maxSegmentsPerMessage, 64, 1, 1000)
  const raw: unknown[] = Array.isArray(e.message) ? e.message : e.message ? [e.message] : []
  const segments: UnknownRecord[] = []
  for (const [position, original] of raw.slice(0, maxSegments).entries()) {
    const source = record(original)
    const data = segmentData(original)
    const sourceType = cleanText(source.type || data.type || "unknown", 64).toLowerCase() || "unknown"
    const type = sourceType === "source" ? "reply" : sourceType
    const item: UnknownRecord = { position, type, sourceType, analysisStatus: type === "text" ? "text" : "unsupported" }
    if (type === "text") {
      item.text = cleanText(data.text ?? source.text ?? "", number(config.maxTextChars, 8000, 100, 100000))
    } else if (type === "at") {
      item.targetId = String(data.qq || data.user_id || data.id || "").trim()
      item.analysisStatus = "reference"
    } else if (type === "reply") {
      item.messageId = String(data.id || data.message_id || data.seq || "").trim()
      item.targetId = String(data.user_id || data.qq || "").trim()
      item.analysisStatus = "reference"
    }
    const meta = safeMeta(data)
    if (Object.keys(meta).length) item.meta = meta
    segments.push(item)
  }
  if (!segments.length) {
    const fallback = cleanText(stripMessageCodes(String(e.raw_message || e.msg || "")), number(config.maxTextChars, 8000, 100, 100000))
    if (fallback) segments.push({ position: 0, type: "text", sourceType: "text", text: fallback, analysisStatus: "text" })
  }
  return segments
}

function normalizeEvent(e: GroupEvent = {}, policy: UnknownRecord = {}): NormalizedEvent {
  const config = groupConfig()
  const segments = normalizeSegments(e, config)
  const text = cleanText(segments.filter(item => item.type === "text").map(item => item.text || "").join(" "), number(config.maxTextChars, 8000, 100, 100000))
    || cleanText(stripMessageCodes(String(e.raw_message || e.msg || "")), number(config.maxTextChars, 8000, 100, 100000))
  const timestamp = sentAt(e)
  const contentHash = hash(JSON.stringify({ text, segments }))
  return {
    id: id(),
    scopeType: "group",
    scopeId: String(e.group_id || "").trim(),
    messageId: eventMessageId(e),
    senderId: eventSenderId(e),
    senderName: eventSenderName(e),
    // 昵称与群名片分开保留（不落原文表），flush 后用于结构化维护称呼记忆。
    senderNickname: cleanText(record(e.sender).nickname || "", 120),
    senderCard: cleanText(record(e.sender).card || "", 120),
    senderRole: cleanText(record(e.sender).role || "", 64),
    sentAt: timestamp,
    text,
    segments,
    contentHash,
    // isCommandMessage 读取 knowledge.commandPrefixes，必须传完整配置快照而不是 groupCapture 子树。
    isCommand: isCommandMessage(text, configStore.get()) ? 1 : 0,
    expiresAt: Number(policy.retention_days || 0) > 0 ? timestamp + Number(policy.retention_days) * DAY : 0,
  }
}

function rowPolicy(row: UnknownRecord = {}): GroupPolicy {
  const defaults = policyDefaults()
  const overrides = {
    retentionDays: row.retention_days !== null && row.retention_days !== undefined,
    tokenLimit: row.token_limit !== null && row.token_limit !== undefined,
    promptTemplate: row.prompt_template !== null && row.prompt_template !== undefined,
    modelName: row.model_name !== null && row.model_name !== undefined,
    maxTokens: row.max_tokens !== null && row.max_tokens !== undefined,
    minConfidence: row.min_confidence !== null && row.min_confidence !== undefined,
    retrievalResultLimit: row.retrieval_result_limit !== null && row.retrieval_result_limit !== undefined,
  }
  const prompt = overrides.promptTemplate ? policyPrompt(row.prompt_template || "") : defaults.promptTemplate
  return {
    scopeType: "group",
    scopeId: String(row.group_id || ""),
    enabled: Boolean(row.enabled),
    // NULL 表示实时继承全局默认；非 NULL 才是本群明确覆盖。
    defaults,
    overrides,
    retentionDays: overrides.retentionDays ? integer(row.retention_days, defaults.retentionDays, 0, 100000000) : defaults.retentionDays,
    tokenLimit: overrides.tokenLimit ? integer(row.token_limit, defaults.tokenLimit, 256, 60000) : defaults.tokenLimit,
    promptTemplate: prompt,
    // 原始覆盖文本（未解析为内置词），供编辑器回显与保存回填，避免把内置提示词物化成本群快照。
    promptTemplateOverride: overrides.promptTemplate ? String(row.prompt_template || "") : "",
    usesDefaultPrompt: !overrides.promptTemplate,
    usesBuiltInPrompt: prompt === DEFAULT_GROUP_MEMORY_PROMPT,
    modelName: overrides.modelName ? cleanText(row.model_name || "", 120) : defaults.modelName,
    maxTokens: overrides.maxTokens ? integer(row.max_tokens, defaults.maxTokens, 256, 65536) : defaults.maxTokens,
    minConfidence: overrides.minConfidence ? number(row.min_confidence, defaults.minConfidence, 0, 1) : defaults.minConfidence,
    retrievalResultLimit: overrides.retrievalResultLimit ? integer(row.retrieval_result_limit, defaults.retrievalResultLimit, 1, 20) : defaults.retrievalResultLimit,
    lastDailyEnd: Number(row.last_daily_end || 0),
    backfill: {
      at: Number(row.last_backfill_at || 0),
      status: String(row.last_backfill_status || ""),
      requested: Number(row.last_backfill_requested || 0),
      received: Number(row.last_backfill_received || 0),
      saved: Number(row.last_backfill_saved || 0),
      error: String(row.last_backfill_error || ""),
    },
    windowProgress: {
      pending: Number(row.pending_windows || 0),
      running: Number(row.running_windows || 0),
      completed: Number(row.completed_windows || 0),
      failed: Number(row.failed_windows || 0),
    },
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  }
}

function selectedChatModel(value: unknown = ""): string {
  const name = cleanText(value, 120)
  if (!name) return ""
  const models = Array.isArray(record(configStore.get()).models) ? records(record(configStore.get()).models) : []
  const model = models.find(item => item.name === name)
  if (!model) throw new Error(`提炼模型不存在：${name}`)
  if (record(model.capabilities).chat === false) throw new Error(`提炼模型不支持对话：${name}`)
  return name
}

function modelJson(text: unknown = ""): JsonResult | null {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  const start = source.indexOf("{")
  const end = source.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(source.slice(start, end + 1))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonResult : null
  } catch { return null }
}

function safeError(err: unknown): string {
  return String(record(err).message || err || "处理失败")
    .replace(/(api[_ -]?key|token|secret|password|authorization|cookie)\s*[:=]\s*[^\s,]+/ig, "$1=<redacted>")
    .slice(0, 500)
}

function parseMoment(value: unknown): number {
  if (!value) return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 100000000000 ? numeric : numeric * 1000
  const time = Date.parse(String(value))
  return Number.isFinite(time) ? time : 0
}

function startOfLocalDay(value: unknown = now()): number {
  const date = new Date(Number(value) || now())
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// 用日历语义取次日零点：夏令时地区的自然日可能是 23/25 小时，固定加 24h 会让游标停在原地。
function dayAfter(value: unknown): number {
  const date = new Date(startOfLocalDay(value))
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

function localDayString(value: unknown = now()): string {
  const date = new Date(startOfLocalDay(value))
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseLocalDay(value: unknown, fallback: unknown, label: string): number {
  const source = String(value || "").trim()
  if (!source) return startOfLocalDay(fallback)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source)
  if (!match) throw new Error(`${label} 必须是 YYYY-MM-DD 格式的自然日。`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)
  date.setHours(0, 0, 0, 0)
  date.setFullYear(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`${label} 不是有效的自然日。`)
  }
  return date.getTime()
}

function extractionResultSummary(value: unknown = "[]"): {
  result: JsonResult
  items: UnknownRecord[]
  memoryResultCount: number
  ignoredResultCount: number
} {
  const parsed = typeof value === "string" ? parseJson(value, []) : value
  const result: JsonResult = Array.isArray(parsed) ? { items: parsed } : record(parsed)
  const items = records(result.items)
  const memoryResultCount = Number.isFinite(Number(result.memoryResultCount))
    ? Math.max(0, Math.round(Number(result.memoryResultCount)))
    : items.filter(item => item?.action !== "ignored").length
  const ignoredResultCount = Number.isFinite(Number(result.ignoredResultCount))
    ? Math.max(0, Math.round(Number(result.ignoredResultCount)))
    : items.filter(item => item?.action === "ignored").length
  return { result, items, memoryResultCount, ignoredResultCount }
}

function resultWithTargetName(item: UnknownRecord = {}, targetNames: Map<string, string> = new Map()): UnknownRecord {
  const scopeType = String(item.scopeType || "")
  if (!["user", "user_group"].includes(scopeType) || String(item.targetName || "").trim()) return item
  const ownerId = String(item.ownerId || item.subjectId || "").trim()
  const targetName = cleanText(targetNames.get(ownerId) || "", 120)
  return targetName ? { ...item, targetName } : item
}

function resultItemsWithTargetNames(items: UnknownRecord[] = [], targetNames: Map<string, string> = new Map()): UnknownRecord[] {
  return items.map(item => resultWithTargetName(item, targetNames))
}

function tokenLimit(value: unknown = policyDefaults().tokenLimit): number {
  return integer(value, policyDefaults().tokenLimit, 256, 60000)
}

function rowTokenCount(row: UnknownRecord = {}): number {
  // 给消息 ID、发言人和提示词分隔符留余量，估算比正文更保守。
  return estimateTokens(`[${row.message_id || ""}] ${row.sender_id || ""}${row.sender_name ? `(${row.sender_name})` : ""}：${row.text_content || ""}`) + 8
}

// 相邻 chunk 之间从前一 chunk 尾部回携若干完整行作为上下文重叠，避免跨 chunk 的
// 问答、确认关系断裂；重叠上限取 min(400, limit 的 10%)，重叠行 token 计入当前
// chunk 的已用额度。重叠会让同一消息进入两个子窗口并产生重复候选，由 applyCandidates
// 的 merged map（factKeyToken 合并）与 evidence 的 (memory_id, source_event_id)
// 幂等约束吸收。预览与实际处理共用本函数，预估和实际切分天然一致。
function partitionRowsByTokens(rows: UnknownRecord[] = [], limit = 30000): PartitionResult {
  const overlapLimit = Math.min(400, Math.floor(limit * 0.1))
  const chunks: UnknownRecord[][] = []
  const skipped: UnknownRecord[] = []
  let chunk: UnknownRecord[] = []
  let used = 0
  const tailOverlap = (closed: UnknownRecord[]): { carried: UnknownRecord[]; carriedTokens: number } => {
    const carried: UnknownRecord[] = []
    let carriedTokens = 0
    for (let index = closed.length - 1; index >= 0; index -= 1) {
      const tokens = rowTokenCount(closed[index])
      if (carriedTokens + tokens > overlapLimit) break
      carried.unshift(closed[index])
      carriedTokens += tokens
    }
    return { carried, carriedTokens }
  }
  for (const row of rows) {
    const tokens = rowTokenCount(row)
    if (tokens > limit) {
      if (chunk.length) chunks.push(chunk)
      chunk = []
      used = 0
      skipped.push(row)
      continue
    }
    if (chunk.length && used + tokens > limit) {
      chunks.push(chunk)
      const { carried, carriedTokens } = tailOverlap(chunk)
      // 携带重叠后仍放不下新行时退回硬切，保证单条不超限的行总能入块。
      if (carriedTokens + tokens > limit) {
        chunk = []
        used = 0
      } else {
        chunk = carried
        used = carriedTokens
      }
    }
    chunk.push(row)
    used += tokens
  }
  if (chunk.length) chunks.push(chunk)
  // estimatedTokens 维持“全部行 token 总和”口径，重叠行不重复计入。
  return { chunks, skipped, estimatedTokens: rows.reduce((sum, row) => sum + rowTokenCount(row), 0) }
}

function normalizedFactValue(value: unknown = "", max = 160): string {
  return cleanText(value, max).toLowerCase()
    .replace(/[\s，,。.!！?？、:：;；'"“”‘’（）()【】\[\]_-]+/g, "")
}

function canonicalFactKey(value: unknown = ""): string {
  const key = cleanText(value, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "")
  return /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/.test(key) ? key : ""
}

function factKeyToken(key: unknown = "", value: unknown = ""): string {
  return `${key}:${normalizedFactValue(value)}`
}

function identityClaims(text: unknown = ""): FactClaim[] {
  const source = cleanText(text, 600)
  const claims = []
  if (/(?:男性|男生|男的|男士|性别\s*(?:为|是)?\s*男)/.test(source)) claims.push({ key: "identity.gender", value: "male", label: "男性" })
  if (/(?:女性|女生|女的|女士|性别\s*(?:为|是)?\s*女)/.test(source)) claims.push({ key: "identity.gender", value: "female", label: "女性" })
  for (const match of source.matchAll(/(?:年龄\s*(?:为|是)?\s*|自述为\s*|今年\s*|现年\s*)?([1-9]\d{0,2})\s*岁/g)) {
    const age = Number(match[1])
    if (age > 0 && age <= 130) claims.push({ key: "identity.age", value: String(age), label: `${age} 岁` })
  }
  const nickname = source.match(/(?:昵称|名字|称呼)(?:是|为|叫)?\s*[“"']?([\p{L}\p{N}_-]{1,32})/u)
    || source.match(/(?:我叫|叫我|称呼我为)\s*[“"']?([\p{L}\p{N}_-]{1,32})/u)
  if (nickname?.[1]) claims.push({ key: "identity.nickname", value: cleanText(nickname[1], 32), label: cleanText(nickname[1], 32) })
  return [...new Map(claims.map(claim => [factKeyToken(claim.key, claim.value), claim])).values()]
}

function canonicalIdentityText(claim: FactClaim, evidence: UnknownRecord[] = []): string {
  if (claim.key === "identity.gender") return `用户自述为${claim.value === "female" ? "女性" : "男性"}`
  if (claim.key === "identity.nickname") return `用户自述昵称为${claim.value}`
  if (claim.key === "identity.age") {
    const timestamp = Number(evidence[0]?.sent_at || now())
    const date = new Date(timestamp).toISOString().slice(0, 10)
    return `用户于 ${date} 自述为${claim.value} 岁`
  }
  return ""
}

function genericFactKey(kind: unknown = "fact", text: unknown = "", declaredKey: unknown = ""): string {
  const declared = canonicalFactKey(declaredKey)
  if (declared) return declared
  const type = cleanText(kind, 36).toLowerCase().replace(/[^a-z0-9_-]+/g, "") || "fact"
  const core = normalizedFactValue(text, 200).slice(0, 80) || "statement"
  return `${type}.${core}`
}

function candidateAtoms(raw: UnknownRecord = {}, evidence: UnknownRecord[] = [], scope: unknown = ""): Candidate[] {
  const text = cleanText(raw?.text || "", 500)
  // 身份归一化只适用于个人作用域；群公共事实里出现年龄/性别字样不代表个人自述。
  const claims = scope === "group" ? [] : identityClaims(text)
  if (claims.length) {
    return claims.map(claim => ({
      ...raw,
      kind: "identity",
      factKey: claim.key,
      factValue: claim.value,
      text: canonicalIdentityText(claim, evidence),
      validTo: claim.key === "identity.age"
        ? (parseMoment(raw.validTo) ? raw.validTo : Number(evidence[0]?.sent_at || now()) + 365 * DAY)
        : raw.validTo,
    }))
  }
  const factKey = genericFactKey(raw?.kind, text, raw?.factKey)
  return [{
    ...raw,
    factKey,
    factValue: cleanText(raw?.factValue || normalizedFactValue(text, 160), 160),
    text,
  }]
}

function rowFacts(row: UnknownRecord = {}): FactClaim[] {
  const storedKey = canonicalFactKey(row.fact_key || row.factKey || "")
  if (storedKey) return [{ key: storedKey, value: String(row.fact_value || row.factValue || normalizedFactValue(row.text)) }]
  const claims = identityClaims(row.text)
  if (claims.length) return claims
  const tags = Array.isArray(row.tags) ? row.tags : []
  return [{ key: genericFactKey(tags[1] || row.type || "fact", row.text), value: normalizedFactValue(row.text) }]
}

// 单值槽位描述“当前状态”：身份、个人资料、群内角色、进行中的计划和交流风格在同一
// 槽位上随时间只有一个现值，新值直接替换（supersede）旧值；preference.* 保持多值，
// 一个人可同时保有多种喜好，取消或矛盾由 retract 候选显式表达而不是互相覆盖。
function isSingleValueFact(factKey: unknown = ""): boolean {
  return factKey === "communication.style" || /^(?:identity|profile|group_role|plan)\./.test(String(factKey))
}

function isDerivedMemory(row: UnknownRecord = {}): boolean {
  return String(row.source || "").startsWith("group-window") || String(row.source || "") === "superseded"
}

function preferredCanonical(rows: UnknownRecord[] = [], candidate: UnknownRecord = {}): UnknownRecord | null {
  const ordered = [...rows].sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0) || String(left.id).localeCompare(String(right.id)))
  const exactStored = ordered.find(row => canonicalFactKey(row.fact_key || "") === candidate.factKey && String(row.fact_value || "") === candidate.factValue)
  if (exactStored) return exactStored
  return ordered.find(row => rowFacts(row).length === 1) || ordered[0] || null
}

function factsCoveredByBatch(row: UnknownRecord = {}, factTokens: Set<string> = new Set()): boolean {
  const facts = rowFacts(row)
  return facts.length > 0 && facts.every(fact => factTokens.has(factKeyToken(fact.key, fact.value)))
}

function extractionPrompt(scopeId: unknown, window: UnknownRecord = {}, rows: UnknownRecord[] = [], template: unknown = ""): string {
  const messages = rows.map(row => {
    const marks = []
    const segments = records(parseJson(row.segments_json, []))
    const reply = segments.find(segment => segment?.type === "reply" && segment?.messageId)
    if (reply) marks.push(`[回复 ${reply.messageId}]`)
    const mentioned = [...new Set(segments.filter(segment => segment?.type === "at" && segment?.targetId).map(segment => String(segment.targetId)))]
    if (mentioned.length) marks.push(`[@${mentioned.join(" @")}]`)
    return `[${row.message_id}] ${row.sender_id}${row.sender_name ? `(${row.sender_name})` : ""}${row.sender_role ? ` [role=${row.sender_role}]` : ""}${marks.length ? ` ${marks.join(" ")}` : ""}：${row.text_content}`
  }).join("\n")
  // 引用/提及格式说明放在固定组装处而不是可被逐群覆盖的默认提示词里，自定义模板同样受益。
  return [
    `群号：${scopeId}`,
    `时间窗：${new Date(Number(window.window_start || 0)).toISOString()} 至 ${new Date(Number(window.window_end || 0)).toISOString()}`,
    policyPrompt(template),
    "消息行内的 [回复 消息ID] 表示该消息回复哪条消息，[@QQ号] 表示提及了哪些成员；可据此判断答复指向、本人确认和多人支持等证据关系。",
    "只返回 JSON：{\"candidates\":[{\"operation\":\"add|retract\",\"scope\":\"user|user_group|group\",\"subjectId\":\"个人记忆对应的用户QQ；group 留空\",\"speakerId\":\"作出直接陈述的原始说话人QQ\",\"factKey\":\"identity.gender\",\"factValue\":\"male\",\"text\":\"第三人称原子事实\",\"kind\":\"identity|preference|relationship|plan|group_rule|experience|episode\",\"confidence\":0.0,\"importance\":0.0,\"sensitivity\":\"normal|sensitive\",\"validTo\":\"ISO 可选\",\"evidenceMessageIds\":[\"消息ID\"]}]}",
    "消息：",
    messages,
  ].join("\n")
}

const EXTRACTOR_SYSTEM = [
  "你是群聊事实记忆提炼器。严格区分三种记忆作用域：user 是跨群可用的个人全局记忆，user_group 是仅当前群可用的个人记忆，group 是当前群的公共记忆；episode 只能作为 kind，不能作为作用域。",
  "产物必须是有证据、可独立理解、可去重更新的原子事实，不是聊天记录或聊天摘要。只可使用输入中的原始消息 ID、用户 ID 和文字；证据不足时返回空 candidates。",
  "用户本人明确自述的名字、昵称、性别、称谓、年龄、兴趣、偏好等普通资料应正常提取。只排除密码、验证码、Token/API Key、Cookie、登录凭证、银行卡或支付信息、身份证件号、完整手机号和精确住址。",
  "个人事实不接受他人转述；不要把玩笑、推测、角色扮演、机器人回复、纯指令或来源不明的转发当作事实。用户本人明确否定或撤回既有事实时，用 operation 为 retract 的候选表达撤回，不要写成新事实。",
  "输出必须是严格 JSON，不要使用 Markdown。",
].join("\n")

function sourceMessageView(row: UnknownRecord = {}): UnknownRecord {
  const segments = records(parseJson(row.segments_json, []))
  const segmentCounts: UnknownRecord = segments.reduce((counts: UnknownRecord, segment) => {
    const type = cleanText(segment?.type || segment?.sourceType || "unknown", 32) || "unknown"
    counts[type] = Number(counts[type] || 0) + 1
    return counts
  }, {})
  const issues = []
  if (Number(row.conflict_count || 0) > 0) issues.push("同一消息 ID 出现内容冲突，已保留最早版本")
  if (segments.some(segment => segment?.type === "unknown" || segment?.sourceType === "unknown")) issues.push("包含未识别消息段，已按原顺序保留")
  if (segments.some(segment => segment?.type === "reply" && !segment?.messageId)) issues.push("回复段缺少目标消息 ID")
  if (segments.some(segment => segment?.type === "at" && !segment?.targetId)) issues.push("@ 段缺少目标用户 ID")
  const hasText = Boolean(String(row.text_content || "").trim())
  return {
    id: row.id, scopeType: "group", scopeId: row.group_id, messageId: row.message_id, senderId: row.sender_id,
    senderName: row.sender_name, senderRole: row.sender_role, sentAt: Number(row.sent_at), text: row.text_content,
    replyMessageId: segments.find(segment => segment?.type === "reply" && segment?.messageId)?.messageId || "", segments, segmentCounts,
    isCommand: Boolean(row.is_command), conflictCount: Number(row.conflict_count || 0), expiresAt: Number(row.expires_at || 0),
    normalization: {
      status: issues.length ? "warning" : (hasText ? "normalized" : "non_text"),
      label: issues.length ? "需要核对" : (hasText ? "已规范" : "非文本已保留"),
      issues,
    },
  }
}

function windowView(row: UnknownRecord = {}, targetNames: Map<string, string> = new Map()): UnknownRecord {
  const { result: resultInfo, items, memoryResultCount, ignoredResultCount } = extractionResultSummary(row.result_json)
  return {
    id: row.id, scopeType: "group", scopeId: row.group_id, windowStart: Number(row.window_start), windowEnd: Number(row.window_end),
    kind: "daily", tokenLimit: Number(row.token_limit || 0), estimatedInputTokens: Number(row.estimated_input_tokens || 0),
    skippedMessageCount: Number(row.skipped_message_count || 0), needsReextract: Boolean(row.needs_reextract),
    contentHash: row.content_hash, extractorVersion: row.extractor_version, status: row.status, attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: Number(row.next_attempt_at || 0), errorMessage: row.error_message, result: resultItemsWithTargetNames(items, targetNames),
    processingChunk: Number(row.processing_chunk || 0), processingChunkTotal: Number(row.processing_chunk_total || 0),
    modelCallCount: Number(resultInfo.modelCallCount || 0), processedMessageCount: Number(resultInfo.messageCount || 0),
    memoryResultCount, ignoredResultCount, truncated: Boolean(resultInfo.truncated), omittedItemCount: Number(resultInfo.omittedItemCount || 0),
    sourceMessageCount: Number(row.source_message_count || 0), sourceFirstAt: Number(row.source_first_at || 0), sourceLastAt: Number(row.source_last_at || 0),
    sourceFirstMessageId: String(row.source_first_message_id || ""), sourceLastMessageId: String(row.source_last_message_id || ""),
    sourceTextChars: Number(row.source_text_chars || 0), sourceMemberCount: Number(row.source_member_count || 0), chunkCount: Number(row.chunk_count || 0),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), completedAt: Number(row.completed_at || 0),
  }
}

export class GroupCaptureStore {
  policies = new Map<string, GroupPolicy>()
  queue: NormalizedEvent[] = []
  flushTimer: ReturnType<typeof setTimeout> | null = null
  flushPromise: Promise<UnknownRecord> | null = null
  // 0 表示默认整批（500）；数据级写失败后减半重试，用于隔离毒消息。
  retryBatchSize = 0
  scanTimer: ReturnType<typeof setInterval> | null = null
  initialized = false
  processing = false
  manualWindowRuns = new Set<string>()
  lastError = ""
  appliedRetentions = new Map<string, number>()
  clearingScopes = new Set<string>()
  clearEpochs = new Map<string, number>()
  scopeLocks = new Map<string, Promise<unknown>>()
  // 槽位 → 最近写入值，避免每批消息都回查同一个人的称呼记忆。
  identityCache = new Map<string, string>()

  key(scopeType: unknown, scopeId: unknown): string { return `${scopeType}:${scopeId}` }

  async withScopeLock<T>(scopeKey: string, action: () => Promise<T> | T): Promise<T> {
    const previous = this.scopeLocks.get(scopeKey) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.scopeLocks.set(scopeKey, current)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.scopeLocks.get(scopeKey) === current) this.scopeLocks.delete(scopeKey)
    }
  }

  clearEpoch(scopeKey: string): number { return Number(this.clearEpochs.get(scopeKey) || 0) }

  async init(): Promise<boolean> {
    if (this.initialized || !sqliteClient.status.available) return this.initialized
    await this.applyConfig(configStore.get(), { force: true })
    this.startScanner()
    this.initialized = true
    return true
  }

  // 保留期可以继承系统默认，也可以由单群覆盖。配置热应用时只重算实际值变化的群，
  // 使继承全局的群自动同步，同时不改写已覆盖群的保留策略。
  async applyConfig(config: UnknownRecord = record(configStore.get()), { force = false }: { force?: boolean } = {}): Promise<UnknownRecord> {
    const captureConfig = record(record(config).memory && record(record(config).memory).groupCapture)
    let updatedMessages = 0
    let removedMessages = 0
    if (sqliteClient.status.available) {
      await this.refreshPolicies()
      const policies = [...this.policies.values()]
      const changed = policies.filter(policy => force || this.appliedRetentions.get(this.key(policy.scopeType, policy.scopeId)) !== policy.retentionDays)
      if (changed.length) {
        const changedKeys = new Set(changed.map(policy => this.key(policy.scopeType, policy.scopeId)))
        for (const item of this.queue) {
          if (!changedKeys.has(this.key(item.scopeType, item.scopeId))) continue
          const policy = this.policies.get(this.key(item.scopeType, item.scopeId))
          const retention = Number(policy?.retentionDays || 0)
          item.expiresAt = retention > 0 ? Number(item.sentAt || now()) + retention * DAY : 0
        }
        // 等待已取走的批次写完，再按每群的实际值重算；否则旧保留期的 in-flight batch
        // 会在更新后落盘，造成同一群原文同时存在两种过期时间。
        if (this.flushPromise) {
          try { await this.flushPromise } catch { /* 失败批次已恢复到队列，并在上面改写过 expiresAt。 */ }
        }
        for (const policy of changed) {
          const result = await sqliteClient.run(
            `UPDATE group_memory_messages
             SET expires_at=CASE WHEN ?=0 THEN 0 ELSE sent_at + ? END
             WHERE group_id=?`,
            [policy.retentionDays, policy.retentionDays * DAY, policy.scopeId],
          )
          updatedMessages += Number(result?.changes || 0)
        }
        removedMessages = Number((await this.cleanupExpired()).messages || 0)
      }
      this.appliedRetentions = new Map(policies.map(policy => [this.key(policy.scopeType, policy.scopeId), policy.retentionDays]))
    }
    return { retentionDays: retentionDays(captureConfig), updatedMessages, removedMessages }
  }

  async stop({ flush = true }: { flush?: boolean } = {}): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.scanTimer = null
    this.flushTimer = null
    if (flush) await this.drain()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.initialized = false
  }

  startScanner(): void {
    if (this.scanTimer) clearInterval(this.scanTimer)
    const interval = number(groupConfig().scanIntervalMs, 300000, 10000, 3600000)
    this.scanTimer = setInterval(() => {
      this.scan().catch(err => this.noteError(err))
    }, interval)
    this.scanTimer.unref?.()
  }

  noteError(err: unknown): void {
    this.lastError = safeError(err)
    hostRuntime.logger?.warn?.(`[yui-chat] 群记忆采集任务失败：${this.lastError}`)
  }

  async refreshPolicies(): Promise<GroupPolicy[]> {
    if (!sqliteClient.status.available) return []
    const rows = await sqliteClient.all("SELECT * FROM group_memory_policies ORDER BY updated_at DESC")
    this.policies.clear()
    for (const row of rows) {
      const policy = rowPolicy(row)
      this.policies.set(this.key(policy.scopeType, policy.scopeId), policy)
    }
    return [...this.policies.values()]
  }

  record(e: GroupEvent = {}): boolean {
    const config = groupConfig()
    if (!sqliteClient.status.available || config.enabled === false || !isGroupEvent(e) || isSelfMessage(e)) return false
    const scopeId = String(e.group_id || "").trim()
    if (this.clearingScopes.has(this.key("group", scopeId))) return false
    const policy = this.policies.get(this.key("group", scopeId))
    if (!scopeId || !policy?.enabled) return false
    const event = normalizeEvent(e, { retention_days: policy.retentionDays })
    if (!event.messageId || !event.senderId) return false
    const cap = number(config.maxPendingMessages, 2000, 100, 50000)
    if (this.queue.length >= cap) {
      this.lastError = "群消息采集队列已满，已跳过新消息。"
      hostRuntime.logger?.warn?.(`[yui-chat] ${this.lastError}`)
      return false
    }
    this.queue.push(event)
    this.scheduleFlush()
    return true
  }

  scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) return
    const delay = number(groupConfig().flushDelayMs, 1000, 100, 300000)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushBatch().catch(err => this.noteError(err))
    }, delay)
    this.flushTimer.unref?.()
  }

  async flushBatch(): Promise<UnknownRecord> {
    if (this.flushPromise) return this.flushPromise
    this.flushPromise = (async () => {
      if (!sqliteClient.status.available || !this.queue.length) return { written: 0 }
      const batch = this.queue.splice(0, Math.min(this.queue.length, this.retryBatchSize || 500))
      const operations = batch.map(item => ({
        sql: `INSERT INTO group_memory_messages(id, group_id, message_id, sender_id, sender_name, sender_role, sent_at, text_content, segments_json, content_hash, is_command, expires_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(group_id, message_id) DO UPDATE SET
            conflict_count = CASE WHEN group_memory_messages.content_hash <> excluded.content_hash THEN group_memory_messages.conflict_count + 1 ELSE group_memory_messages.conflict_count END`,
        params: [
          item.id, item.scopeId, item.messageId, item.senderId, item.senderName, item.senderRole,
          item.sentAt, item.text, JSON.stringify(item.segments), item.contentHash, item.isCommand, item.expiresAt,
        ],
      }))
      try {
        await sqliteClient.transaction(operations)
        this.retryBatchSize = 0
      } catch (error) {
        if (!sqliteClient.status.available || batch.length > 1) {
          // 事务失败时保留原批次，避免 SQLite 临时不可用造成原文静默丢失；
          // 连接仍可用说明是数据级失败，下一批减半重试把毒消息收敛到单条，
          // 防止一条非法消息让全局采集队列无限重试停摆。
          this.queue.unshift(...batch)
          this.retryBatchSize = sqliteClient.status.available ? Math.ceil(batch.length / 2) : 0
          throw error
        }
        // 单条仍失败属永久性数据错误（如 STRICT/CHECK 违规）：丢弃并记录原因，其余消息继续落盘。
        this.retryBatchSize = 0
        this.noteError(new Error(`群 ${batch[0]?.scopeId || "?"} 消息 ${batch[0]?.messageId || "?"} 落盘失败已丢弃：${safeError(error)}`))
        return { written: 0 }
      }
      try {
        await this.syncSenderIdentities(batch)
      } catch (error) {
        // 称呼记忆只是元数据镜像，失败不影响已落盘的原文批次，下一批消息会再次触发。
        this.noteError(error)
      }
      if (this.queue.length) this.scheduleFlush()
      return { written: batch.length }
    })()
    try { return await this.flushPromise } finally {
      this.flushPromise = null
      if (this.queue.length) this.scheduleFlush()
    }
  }

  async flush(): Promise<UnknownRecord> { return this.drain() }

  async drain(): Promise<UnknownRecord> {
    let written = 0
    // flushBatch 保持单批有界，供定时路径平滑写入；对外 flush 以及 stop/scan/backfill
    // 则显式排空。SQLite 不可用时 flushBatch 不消费队列，必须退出而不是自旋等待：
    // 队列保留在内存中，恢复可用后由 scheduleFlush 或下一次 drain 继续落盘。
    while (this.queue.length || this.flushPromise) {
      if (!this.flushPromise && !sqliteClient.status.available) {
        this.noteError(new Error(`SQLite 不可用，${this.queue.length} 条已采集消息暂留内存队列`))
        break
      }
      try {
        const result = this.flushPromise ? await this.flushPromise : await this.flushBatch()
        written += Number(result?.written || 0)
      } catch (error) {
        if (!sqliteClient.status.available) throw error
        // 数据级失败由 flushBatch 缩批重试并最终丢弃毒消息收敛，这里记录后继续排空剩余队列。
        this.noteError(error)
      }
    }
    return { written }
  }

  // 平台昵称与群名片是消息元数据而不是用户自述，直接结构化维护为单值记忆，不经过模型提炼：
  // QQ 昵称跨群有效写入 user 作用域（identity.qq_nickname），群名片只在本群有效写入
  // user_group 作用域（identity.group_card）。值变化时归档旧值（superseded），改名自动更新。
  async syncSenderIdentities(batch: NormalizedEvent[] = []): Promise<void> {
    const latest = new Map<string, NormalizedEvent>()
    // 批内按入队顺序覆盖，同一发言人取最新一条的称呼；按“人＋群”分键，
    // 同批内同一人在多个群发言时，各群的名片更新互不覆盖。
    for (const item of batch) {
      if (item.senderId && item.scopeType === "group") latest.set(`${item.senderId}:${item.scopeId}`, item)
    }
    for (const item of latest.values()) {
      if (item.senderNickname) {
        await this.upsertIdentityFact(
          { scopeType: "user", ownerId: item.senderId, groupId: "" },
          "identity.qq_nickname", item.senderNickname, `用户当前的 QQ 昵称为「${item.senderNickname}」`,
        )
      }
      // 群名片为空表示回显 QQ 昵称，与昵称相同也无需单独记录；历史名片值保留到下次真实改名。
      if (item.senderCard && item.senderCard !== item.senderNickname) {
        await this.upsertIdentityFact(
          { scopeType: "user_group", ownerId: item.senderId, groupId: item.scopeId },
          "identity.group_card", item.senderCard, `用户在本群的群名片为「${item.senderCard}」`,
        )
      }
    }
  }

  async upsertIdentityFact(scope: MemoryScope, factKey: string, factValue: string, text: string): Promise<void> {
    const cacheKey = `${scope.scopeType}:${scope.ownerId}:${scope.groupId}:${factKey}`
    if (this.identityCache.get(cacheKey) === factValue) return
    const rows = await memoryRepository.listByFactKey(scope, factKey)
    if (rows.some(row => String(row.fact_value) === factValue)) {
      this.identityCache.set(cacheKey, factValue)
      return
    }
    // 平台数据是这两个槽位的权威来源：旧值全部归档，复用 superseded 的修订与清理语义。
    for (const row of rows) {
      await memoryRepository.update(row.id, { status: "archived", source: "superseded" })
    }
    await memoryRepository.insert({
      ...scope, type: "fact", text, normalized: text.toLowerCase(),
      factKey, factValue, tags: ["platform-metadata", "identity"],
      importance: 0.5, confidence: 0.95,
      source: "platform-metadata",
    })
    this.identityCache.set(cacheKey, factValue)
    if (this.identityCache.size > 5000) {
      const firstKey = this.identityCache.keys().next().value
      if (typeof firstKey === "string") this.identityCache.delete(firstKey)
    }
  }

  // NULL 代表继承系统默认；按字段恢复继承不会改写既有消息或提炼任务。
  async setPolicy(scopeType: unknown, scopeId: unknown, patch: UnknownRecord = {}): Promise<GroupPolicy | undefined> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue) throw new Error("采集范围和对象 ID 不能为空。")
    if (type !== "group") throw new Error("第一版仅支持指定群采集。")
    const current = this.policies.get(this.key(type, idValue))
    const enabled = patch.enabled === undefined ? Boolean(current?.enabled) : patch.enabled === true
    const timestamp = now()
    const config = groupConfig()
    const defaults = policyDefaults(config)
    const requestedOverrides = record(patch.overrides)
    const inherit = (key: string): boolean => Object.hasOwn(requestedOverrides, key) ? requestedOverrides[key] !== true : !current?.overrides?.[key]
    const retention = inherit("retentionDays") ? null : integer(patch.retentionDays ?? current?.retentionDays, defaults.retentionDays, 0, 100000000)
    const inputTokenLimit = inherit("tokenLimit") ? null : integer(patch.tokenLimit ?? current?.tokenLimit, defaults.tokenLimit, 256, 60000)
    const promptTemplate = inherit("promptTemplate") ? null : cleanPrompt(patch.promptTemplate ?? current?.promptTemplateOverride ?? "")
    const modelName = inherit("modelName") ? null : cleanText(patch.modelName ?? current?.modelName ?? "", 120)
    const maxTokens = inherit("maxTokens") ? null : integer(patch.maxTokens ?? current?.maxTokens, defaults.maxTokens, 256, 65536)
    const minConfidence = inherit("minConfidence") ? null : number(patch.minConfidence ?? current?.minConfidence, defaults.minConfidence, 0, 1)
    const retrievalResultLimit = inherit("retrievalResultLimit")
      ? null
      : integer(patch.retrievalResultLimit ?? current?.retrievalResultLimit, defaults.retrievalResultLimit, 1, 20)
    if (modelName) selectedChatModel(modelName)
    await sqliteClient.run(
      `INSERT INTO group_memory_policies(
         group_id, enabled, retention_days, token_limit, prompt_template, model_name, max_tokens, min_confidence, retrieval_result_limit,
         last_daily_end, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         enabled=excluded.enabled, retention_days=excluded.retention_days, token_limit=excluded.token_limit,
         prompt_template=excluded.prompt_template, model_name=excluded.model_name,
         max_tokens=excluded.max_tokens, min_confidence=excluded.min_confidence,
         retrieval_result_limit=excluded.retrieval_result_limit,
         updated_at=excluded.updated_at`,
      [
        idValue, enabled ? 1 : 0, retention, inputTokenLimit, promptTemplate, modelName, maxTokens, minConfidence, retrievalResultLimit, timestamp, timestamp,
      ],
    )
    await this.refreshPolicies()
    await this.applyConfig(configStore.get())
    return this.policies.get(this.key(type, idValue))
  }

  async listPolicies(options: UnknownRecord = {}): Promise<UnknownRecord[]> {
    if (!sqliteClient.status.available) return []
    const includeMessageStats = options.includeMessageStats !== false
    const [rows, windowRows, messageRows] = await Promise.all([
      sqliteClient.all("SELECT * FROM group_memory_policies ORDER BY updated_at DESC"),
      sqliteClient.all(
        `SELECT group_id, status, COUNT(*) AS count
         FROM group_memory_extraction_jobs
         WHERE extractor_version=?
         GROUP BY group_id, status`,
        [EXTRACTOR_VERSION],
      ),
      includeMessageStats
        ? sqliteClient.all(
          `SELECT group_id, COUNT(*) AS message_count, MIN(sent_at) AS oldest_message_at, MAX(sent_at) AS newest_message_at
           FROM group_memory_messages
           GROUP BY group_id`,
        )
        : Promise.resolve([]),
    ])
    const windowsByGroup = new Map()
    for (const row of windowRows) {
      const current = windowsByGroup.get(row.group_id) || {}
      current[`${row.status}_windows`] = Number(row.count || 0)
      windowsByGroup.set(row.group_id, current)
    }
    const messagesByGroup = new Map(messageRows.map(row => [String(row.group_id), row]))
    return rows.map(row => {
      const policy = rowPolicy({ ...row, ...(windowsByGroup.get(row.group_id) || {}) })
      if (!includeMessageStats) return policy
      const stats = messagesByGroup.get(String(row.group_id)) || {}
      return {
        ...policy,
        messageCount: Number(stats.message_count || 0),
        oldestMessageAt: Number(stats.oldest_message_at || 0),
        newestMessageAt: Number(stats.newest_message_at || 0),
      }
    })
  }

  async listMessages(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord[]> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue) throw new Error("采集范围和对象 ID 不能为空。")
    const limit = number(options.limit, 50, 1, 200)
    const before = number(options.before, 0, 0)
    const rows = await sqliteClient.all(
      `SELECT * FROM group_memory_messages WHERE group_id=? ${before ? "AND sent_at < ?" : ""} ORDER BY sent_at DESC LIMIT ?`,
      before ? [idValue, before, limit] : [idValue, limit],
    )
    return rows.map(sourceMessageView)
  }

  async listMessagePage(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue) throw new Error("采集范围和对象 ID 不能为空。")
    const pageSize = number(options.pageSize, 50, 1, 200)
    const page = number(options.page, 1, 1, 1000000)
    const order = String(options.order || "").toLowerCase() === "asc" ? "asc" : "desc"
    const orderBy = order === "asc" ? "sent_at ASC, message_id ASC" : "sent_at DESC, message_id DESC"
    const query = cleanText(options.query || "", 200)
    const where = ["group_id=?"]
    const params: unknown[] = [idValue]
    const from = parseMoment(options.from)
    const to = parseMoment(options.to)
    if (from) {
      where.push("sent_at>=?")
      params.push(from)
    }
    if (to) {
      where.push("sent_at<?")
      params.push(to)
    }
    if (query) {
      const pattern = `%${query}%`
      where.push("(message_id LIKE ? OR sender_id LIKE ? OR sender_name LIKE ? OR text_content LIKE ?)")
      params.push(pattern, pattern, pattern, pattern)
    }
    const clause = where.join(" AND ")
    const total = Number((await sqliteClient.get(`SELECT COUNT(*) AS total FROM group_memory_messages WHERE ${clause}`, params))?.total || 0)
    const rows = await sqliteClient.all(
      `SELECT * FROM group_memory_messages WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    )
    const items = rows.map(sourceMessageView)
    return { items, total, page, pageSize, order }
  }

  async getDailyCalendar(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (type !== "group" || !idValue) throw new Error("第一版仅支持查看指定群的按日提炼日历。")
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy) throw new Error("请先保存这个群的采集配置。")
    await this.drain()

    const todayStart = startOfLocalDay(now())
    const requestedDays = Number(options.days)
    let fromStart: number
    let toStart: number
    if (Number.isFinite(requestedDays) && requestedDays > 0) {
      const days = Math.min(371, Math.max(1, Math.floor(requestedDays)))
      toStart = todayStart
      const fromDate = new Date(todayStart)
      fromDate.setDate(fromDate.getDate() - (days - 1))
      fromStart = startOfLocalDay(fromDate.getTime())
    } else {
      const defaultFromDate = new Date(todayStart)
      defaultFromDate.setDate(defaultFromDate.getDate() - 364)
      fromStart = parseLocalDay(options.fromDay, defaultFromDate.getTime(), "fromDay")
      toStart = parseLocalDay(options.toDay, todayStart, "toDay")
    }
    if (fromStart > toStart) throw new Error("fromDay 不能晚于 toDay。")
    if (toStart > todayStart) throw new Error("toDay 不能晚于今天。")

    const dayStarts = []
    for (let cursor = fromStart; cursor <= toStart;) {
      if (dayStarts.length >= 371) throw new Error("日历一次最多查看 371 天，请缩短日期范围。")
      dayStarts.push(cursor)
      const next = dayAfter(cursor)
      if (next <= cursor) throw new Error("无法计算下一自然日，请检查系统时区配置。")
      cursor = next
    }
    const rangeEnd = dayAfter(toStart)
    const [messageRows, jobRows] = await Promise.all([
      sqliteClient.all(
        `SELECT MIN(sent_at) AS sample_at,
                COUNT(*) AS message_count,
                COALESCE(SUM(length(text_content)), 0) AS text_chars
         FROM group_memory_messages
         WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
         GROUP BY strftime('%Y-%m-%d', sent_at / 1000, 'unixepoch', 'localtime')
         ORDER BY sample_at ASC`,
        [idValue, fromStart, rangeEnd],
      ),
      sqliteClient.all(
        `SELECT id, window_start, window_end, status, token_limit, updated_at,
                estimated_input_tokens, needs_reextract,
                CASE
                  WHEN json_extract(result_json, '$.memoryResultCount') IS NOT NULL
                    THEN json_extract(result_json, '$.memoryResultCount')
                  ELSE COALESCE((
                    SELECT SUM(CASE WHEN COALESCE(json_extract(item.value, '$.action'), '') <> 'ignored' THEN 1 ELSE 0 END)
                    FROM json_each(
                      CASE
                        WHEN json_type(result_json)='array' THEN result_json
                        WHEN json_type(result_json, '$.items')='array' THEN json_extract(result_json, '$.items')
                        ELSE '[]'
                      END
                    ) AS item
                  ), 0)
                END AS result_memory_count,
                CASE
                  WHEN json_extract(result_json, '$.ignoredResultCount') IS NOT NULL
                    THEN json_extract(result_json, '$.ignoredResultCount')
                  ELSE COALESCE((
                    SELECT SUM(CASE WHEN COALESCE(json_extract(item.value, '$.action'), '') = 'ignored' THEN 1 ELSE 0 END)
                    FROM json_each(
                      CASE
                        WHEN json_type(result_json)='array' THEN result_json
                        WHEN json_type(result_json, '$.items')='array' THEN json_extract(result_json, '$.items')
                        ELSE '[]'
                      END
                    ) AS item
                  ), 0)
                END AS result_ignored_count,
                json_extract(result_json, '$.modelCallCount') AS result_model_call_count,
                json_extract(result_json, '$.messageCount') AS result_message_count,
                json_extract(result_json, '$.estimatedInputTokens') AS result_estimated_input_tokens
         FROM group_memory_extraction_jobs
         WHERE group_id=? AND extractor_version=? AND window_end>? AND window_start<?
         ORDER BY updated_at DESC, id DESC`,
        [idValue, EXTRACTOR_VERSION, fromStart, rangeEnd],
      ),
    ])

    const messagesByDay = new Map<number, { messageCount: number; textChars: number }>()
    for (const row of messageRows) {
      const day = startOfLocalDay(Number(row.sample_at))
      messagesByDay.set(day, {
        messageCount: Math.max(0, Number(row.message_count || 0)),
        textChars: Math.max(0, Number(row.text_chars || 0)),
      })
    }
    const jobsByWindow = new Map<string, UnknownRecord>()
    for (const row of jobRows) {
      const key = `${Number(row.window_start)}:${Number(row.window_end)}`
      if (!jobsByWindow.has(key)) jobsByWindow.set(key, row)
    }

    const currentTokenLimit = tokenLimit(policy.tokenLimit)
    const items = dayStarts.map(windowStart => {
      const windowEnd = dayAfter(windowStart)
      const messageSummary = messagesByDay.get(windowStart) || { messageCount: 0, textChars: 0 }
      const rawAvailable = messageSummary.messageCount > 0
      const window = jobsByWindow.get(`${windowStart}:${windowEnd}`) || null
      const windowStatus = String(window?.status || "")
      const memoryResultCount = Math.max(0, Number(window?.result_memory_count || 0))
      const ignoredResultCount = Math.max(0, Number(window?.result_ignored_count || 0))
      const needsReextract = Boolean(window?.needs_reextract)
      const closed = windowEnd <= todayStart
      const messageCount = rawAvailable ? messageSummary.messageCount : Math.max(0, Number(window?.result_message_count || 0))
      // 日历只需要活动强度，不需要重新切分每条原文。已有任务优先使用提炼时保存的
      // 估算；尚未入队或补录后待重提炼的日期按字符量给出保守的轻量估算。
      const lightweightEstimate = rawAvailable
        ? Math.max(0, Math.ceil(messageSummary.textChars / 2.5) + messageSummary.messageCount * 8)
        : 0
      const storedEstimate = Math.max(0, Number(window?.result_estimated_input_tokens || window?.estimated_input_tokens || 0))
      const estimatedInputTokens = needsReextract || !storedEstimate ? lightweightEstimate || storedEstimate : storedEstimate
      const storedCallCount = window?.result_model_call_count === null || window?.result_model_call_count === undefined
        ? -1
        : Math.max(0, Number(window.result_model_call_count || 0))
      const modelCallCount = storedCallCount >= 0
        ? storedCallCount
        : estimatedInputTokens > 0
          ? Math.max(1, Math.ceil(estimatedInputTokens / Math.max(1, Number(window?.token_limit || currentTokenLimit))))
          : 0
      const status = !window
        ? (rawAvailable ? "unprocessed" : "empty")
        : windowStatus === "failed"
          ? "failed"
          : windowStatus === "completed"
            ? (memoryResultCount > 0 ? "memory" : "no_result")
            : "unprocessed"
      return {
        day: localDayString(windowStart),
        windowStart,
        windowEnd,
        windowId: String(window?.id || ""),
        updatedAt: Number(window?.updated_at || 0),
        status,
        windowStatus,
        closed,
        needsReextract,
        rawAvailable,
        messageCount,
        estimatedInputTokens,
        modelCallCount,
        memoryResultCount,
        ignoredResultCount,
        canReextract: Boolean(policy.enabled && closed && rawAvailable && !["pending", "running"].includes(windowStatus)),
      }
    })
    const counts: Record<string, number> = { memory: 0, no_result: 0, unprocessed: 0, failed: 0, empty: 0 }
    for (const item of items) counts[String(item.status)] = Number(counts[String(item.status)] || 0) + 1
    return {
      scopeType: type,
      scopeId: idValue,
      fromDay: localDayString(fromStart),
      toDay: localDayString(toStart),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
      todayDay: localDayString(todayStart),
      dayCount: items.length,
      counts,
      items,
    }
  }

  async reextractionPlan(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (type !== "group" || !idValue) throw new Error("第一版仅支持规划指定群的记忆提炼。")
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy) throw new Error("请先保存这个群的采集配置。")
    await this.drain()
    const [oldest, newest] = await Promise.all([
      sqliteClient.get(
        "SELECT sent_at FROM group_memory_messages WHERE group_id=? AND is_command=0 AND text_content<>'' ORDER BY sent_at ASC LIMIT 1",
        [idValue],
      ),
      sqliteClient.get(
        "SELECT sent_at FROM group_memory_messages WHERE group_id=? AND is_command=0 AND text_content<>'' ORDER BY sent_at DESC LIMIT 1",
        [idValue],
      ),
    ])
    const oldestAt = Number(oldest?.sent_at || 0)
    const newestAt = Number(newest?.sent_at || 0)
    if (!oldestAt || !newestAt) {
      return { scopeType: type, scopeId: idValue, tokenLimit: tokenLimit(policy.tokenLimit), oldestAt: 0, newestAt: 0, startAt: 0, endAt: 0, messageCount: 0, textChars: 0, estimatedInputTokens: 0, memberCount: 0, modelCallCount: 0, dayCount: 0, windowCount: 0, windows: [], truncated: false }
    }
    const requestedStart = parseMoment(options.startAt) || Math.max(oldestAt, newestAt - 14 * DAY)
    const requestedEnd = parseMoment(options.endAt) || newestAt
    if (requestedStart > newestAt || requestedEnd < oldestAt || requestedEnd < requestedStart) throw new Error("请选择包含已保存原始消息的有效日期范围。")
    const startAt = startOfLocalDay(Math.max(oldestAt, requestedStart))
    const endAt = dayAfter(Math.min(newestAt, requestedEnd))
    const dayCount = Math.round((endAt - startAt) / DAY)
    if (dayCount > 3660) throw new Error("所选范围超过 10 年，请缩短提炼日期范围。")
    const rows = await sqliteClient.all(
      `SELECT message_id, sender_id, sent_at, text_content, segments_json, content_hash, conflict_count
       FROM group_memory_messages
       WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
       ORDER BY sent_at ASC, message_id ASC`,
      [idValue, startAt, endAt],
    )
    const byDay = new Map<number, UnknownRecord[]>()
    for (const row of rows) {
      const day = startOfLocalDay(row.sent_at)
      const list = byDay.get(day) || []
      list.push(row)
      byDay.set(day, list)
    }
    const existingRows = await sqliteClient.all(
      `SELECT * FROM group_memory_extraction_jobs
       WHERE group_id=? AND extractor_version=? AND window_end>? AND window_start<?
       ORDER BY updated_at DESC`,
      [idValue, EXTRACTOR_VERSION, startAt, endAt],
    )
    const existing = new Map<string, UnknownRecord>()
    for (const row of existingRows) {
      const key = `${Number(row.window_start)}:${Number(row.window_end)}`
      if (!existing.has(key)) existing.set(key, row)
    }
    const windows: UnknownRecord[] = []
    let modelCallCount = 0
    const limit = tokenLimit(policy.tokenLimit)
    for (let day = startAt; day < endAt; day = dayAfter(day)) {
      const dayEnd = dayAfter(day)
      const dayRows = byDay.get(day) || []
      const partition = partitionRowsByTokens(dayRows, limit)
      const textChars = dayRows.reduce((sum, row) => sum + String(row.text_content || "").length, 0)
      const members = new Set(dayRows.map(row => String(row.sender_id))).size
      const warnings = dayRows.filter(row => Number(row.conflict_count || 0) > 0 || String(row.segments_json || "").includes('"type":"unknown"')).length
      const current = existing.get(`${day}:${dayEnd}`)
      const currentView = current ? windowView({ ...current, source_message_count: dayRows.length, source_text_chars: textChars, source_member_count: members }) : null
      const currentHash = hash(dayRows.map(row => `${row.message_id}:${row.content_hash}`).join("\n"))
      const changed = Boolean(current && current.content_hash !== currentHash)
      const calls = partition.chunks.length
      modelCallCount += Number(currentView?.modelCallCount || calls)
      windows.push({
        windowStart: day, windowEnd: dayEnd, kind: "daily", messageCount: dayRows.length, textChars, memberCount: members, warningCount: warnings,
        estimatedInputTokens: partition.estimatedTokens, tokenLimit: limit, skippedMessageCount: partition.skipped.length,
        modelCallCount: currentView?.modelCallCount || calls, chunkCount: currentView?.modelCallCount || calls, existingWindowId: current?.id || "",
        status: current?.status || (dayRows.length ? "unprocessed" : "empty"), needsReextract: Boolean(currentView?.needsReextract || changed),
        result: currentView?.result || [], errorMessage: currentView?.errorMessage || "", attemptCount: currentView?.attemptCount || 0,
        processingChunk: currentView?.processingChunk || 0, processingChunkTotal: currentView?.processingChunkTotal || 0,
      })
    }
    const maxPreviewWindows = number(options.maxPreviewWindows, 500, 20, 2000)
    const selectedMessageCount = windows.reduce((sum, item) => sum + Number(item.messageCount || 0), 0)
    const selectedTextChars = windows.reduce((sum, item) => sum + Number(item.textChars || 0), 0)
    const selectedMemberIds = new Set(rows.map(row => String(row.sender_id || "")).filter(Boolean))
    return {
      scopeType: type, scopeId: idValue, tokenLimit: limit, oldestAt, newestAt, startAt, endAt,
      messageCount: selectedMessageCount, textChars: selectedTextChars, memberCount: selectedMemberIds.size,
      selectedMessageCount,
      selectedTextChars,
      estimatedInputTokens: windows.reduce((sum, item) => sum + Number(item.estimatedInputTokens || 0), 0), modelCallCount, dayCount, windowCount: windows.reduce((sum, item) => sum + Number(item.modelCallCount || 0), 0),
      windows: windows.slice(-maxPreviewWindows), truncated: windows.length > maxPreviewWindows,
      allWindows: options.includeAll ? windows : undefined,
    }
  }

  async previewReextraction(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const plan = await this.reextractionPlan(scopeType, scopeId, options)
    delete plan.allWindows
    return plan
  }

  async queueWindowStarts(scopeType: unknown, scopeId: unknown, windowStarts: unknown[] = [], options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (type !== "group" || !idValue) throw new Error("第一版仅支持提炼指定群的日窗口。")
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy) throw new Error("请先保存这个群的采集配置。")
    if (!policy.enabled) throw new Error("请先开启这个群的消息采集。")
    if (!Array.isArray(windowStarts)) throw new Error("windowStarts 必须是自然日开始时间数组。")
    const maxWindows = integer(options.maxWindows, 100, 1, 3660)
    const starts: number[] = []
    const seen = new Set<number>()
    for (const value of windowStarts) {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0 || startOfLocalDay(numeric) !== numeric) {
        throw new Error("所选窗口必须使用自然日开始时间。")
      }
      if (seen.has(numeric)) continue
      seen.add(numeric)
      starts.push(numeric)
    }
    if (starts.length > maxWindows) throw new Error(`一次最多选择 ${maxWindows} 个窗口。`)
    const emptyResult: WindowQueueSummary = {
      mode: "selection",
      requested: starts.length,
      queued: 0,
      alreadyQueued: 0,
      skippedEmpty: 0,
      messageCount: 0,
      estimatedInputTokens: 0,
      estimatedModelCalls: 0,
      queuedWindowStarts: [],
      alreadyQueuedWindowStarts: [],
      skippedEmptyWindowStarts: [],
    }
    if (!starts.length) return emptyResult

    const result = await this.withScopeLock<WindowQueueSummary>(this.key(type, idValue), async () => {
      const existingRows = await sqliteClient.all(
        `SELECT window_start, status
         FROM group_memory_extraction_jobs
         WHERE group_id=? AND extractor_version=?
           AND window_start IN (${starts.map(() => "?").join(",")})`,
        [idValue, EXTRACTOR_VERSION, ...starts],
      )
      const existing = new Map(existingRows.map(row => [Number(row.window_start), String(row.status)]))
      const summary: WindowQueueSummary = { ...emptyResult, queuedWindowStarts: [], alreadyQueuedWindowStarts: [], skippedEmptyWindowStarts: [] }
      for (const start of starts) {
        if (["pending", "running"].includes(existing.get(start) || "")) {
          summary.alreadyQueued += 1
          summary.alreadyQueuedWindowStarts.push(start)
          continue
        }
        const queued = await this.createDailyWindow(type, idValue, start, dayAfter(start), { requeue: true })
        if (!queued) {
          summary.skippedEmpty += 1
          summary.skippedEmptyWindowStarts.push(start)
          continue
        }
        if (!queued.queued) {
          summary.alreadyQueued += 1
          summary.alreadyQueuedWindowStarts.push(start)
          continue
        }
        summary.queued += 1
        summary.queuedWindowStarts.push(start)
        summary.messageCount += queued.rows.length
        summary.estimatedInputTokens += Number(queued.partition?.estimatedTokens || 0)
        summary.estimatedModelCalls += Number(queued.partition?.chunks?.length || 0)
      }
      return summary
    })
    if (result.queued) {
      const timer = setTimeout(() => this.processDueWindows().catch(err => this.noteError(err)), 0)
      timer.unref?.()
    }
    return result
  }

  async queueReextraction(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    if (options.windowStarts !== undefined) {
      return this.queueWindowStarts(scopeType, scopeId, Array.isArray(options.windowStarts) ? options.windowStarts : [])
    }
    const plan = await this.reextractionPlan(scopeType, scopeId, { ...options, includeAll: true })
    const allWindows = records(plan.allWindows)
    const selected = allWindows.filter(window => window.messageCount).map(window => Number(window.windowStart))
    const queued = await this.queueWindowStarts(plan.scopeType, plan.scopeId, selected, { maxWindows: 3660 })
    return {
      ...queued,
      mode: "range",
      dayCount: plan.dayCount,
      windowCount: plan.windowCount,
      messageCount: plan.selectedMessageCount,
      textChars: plan.selectedTextChars,
      estimatedInputTokens: plan.estimatedInputTokens,
      estimatedModelCalls: plan.windowCount,
      startAt: plan.startAt,
      endAt: plan.endAt,
    }
  }

  async backfillHistory(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (type !== "group" || !idValue) throw new Error("第一版仅支持补录指定群的历史消息。")
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy?.enabled) throw new Error("请先保存并开启这个群的消息采集。")
    const maxMessages = integer(groupConfig().historyBackfillMaxMessages, 500, 1, 5000)
    const sinceAt = parseMoment(options.sinceAt)
    // 按日期补录默认拉到单次上限；按数量补录保持旧默认 100 条。
    const limit = integer(options.limit, sinceAt ? maxMessages : 100, 1, maxMessages)
    // 起点游标：指定消息 ID 从该消息继续向前，或一键从本群已存最旧一条继续；
    // 大批量历史靠多次请求递进补录，每次都有界，去重由 (group_id, message_id) 保证。
    let startCursor = cleanText(options.beforeMessageId || "", 200)
    if (!startCursor && options.continueFromOldest) {
      const oldestStored = await sqliteClient.get("SELECT message_id FROM group_memory_messages WHERE group_id=? ORDER BY sent_at ASC, message_id ASC LIMIT 1", [idValue])
      startCursor = String(oldestStored?.message_id || "")
    }
    const started = now()
    await sqliteClient.run(
      "UPDATE group_memory_policies SET last_backfill_at=?, last_backfill_status='running', last_backfill_requested=?, last_backfill_received=0, last_backfill_saved=0, last_backfill_error='' WHERE group_id=?",
      [started, limit, idValue],
    )
    try {
      const bot = hostRuntime.bot
      const pickGroup = bot && typeof bot.pickGroup === "function"
        ? bot.pickGroup as (groupId: string) => Promise<unknown>
        : undefined
      const group = record(await pickGroup?.call(bot, idValue))
      if (typeof group.getChatHistory !== "function") {
        throw new Error("当前适配器未提供这个群的历史消息读取能力。")
      }
      const chatHistory = group.getChatHistory as (cursor: string | number, count: number) => Promise<unknown>
      const before = Number((await sqliteClient.get("SELECT COUNT(*) AS total FROM group_memory_messages WHERE group_id=?", [idValue]))?.total || 0)
      let queued = 0
      let received = 0
      let reachedSince = false
      let exhausted = false
      let oldestSeen: { time: number; messageId: string } | null = null
      const capturedTimes: number[] = []
      // OneBot get_group_msg_history 只有 seq/count 游标，没有日期参数；按日期或按量补录都
      // 通过“取最旧一条的 message_id 作为下一页游标”向前翻页，直到越过 sinceAt 或翻不动为止。
      // NapCat 把 message_seq 参数按消息 ID 解析，适配器同时传 message_id 兼容拉格朗日，
      // 因此统一用 message_id 做游标对两者都成立。
      let cursor = startCursor
      const seenCursors = new Set(startCursor ? [startCursor] : [])
      while (received < limit) {
        const pageSize = Math.min(200, limit - received)
        let response
        try {
          response = await chatHistory.call(group, cursor || 0, pageSize)
        } catch (err) {
          throw new Error(`读取群历史消息失败：${safeError(err)}`)
        }
        const rows = historyRows(response)
        if (!rows.length) {
          exhausted = true
          break
        }
        received += rows.length
        let oldest: { time: number; messageId: string } | null = null
        for (const row of rows) {
          const senderId = String(row?.user_id || record(row?.sender).user_id || "").trim()
          const messageId = String(row?.message_id || row?.messageId || row?.id || row?.seq || "").trim()
          const rowTime = sentAt(row)
          if (!oldest || rowTime < oldest.time) oldest = { time: rowTime, messageId }
          if (!senderId || !messageId) continue
          if (sinceAt && rowTime < sinceAt) continue
          if (this.record({ ...row, isGroup: true, message_type: "group", group_id: idValue, user_id: senderId, message_id: messageId })) {
            queued += 1
            capturedTimes.push(rowTime)
          }
        }
        if (oldest && (!oldestSeen || oldest.time < oldestSeen.time)) oldestSeen = oldest
        // 每页落盘一次：大批量补录不会把内存队列顶到 maxPendingMessages 而丢消息。
        await this.drain()
        if (sinceAt && oldest && oldest.time < sinceAt) {
          reachedSince = true
          break
        }
        if (rows.length < pageSize) {
          exhausted = true
          break
        }
        const nextCursor = oldest?.messageId || ""
        if (!nextCursor || seenCursors.has(nextCursor)) {
          exhausted = true
          break
        }
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
      await this.drain()
      const after = Number((await sqliteClient.get("SELECT COUNT(*) AS total FROM group_memory_messages WHERE group_id=?", [idValue]))?.total || 0)
      const saved = Math.max(0, after - before)
      await this.markChangedDailyWindows(type, idValue, capturedTimes)
      const windowsQueued = await this.queueBackfillWindows(type, idValue, capturedTimes)
      await sqliteClient.run(
        "UPDATE group_memory_policies SET last_backfill_at=?, last_backfill_status='completed', last_backfill_received=?, last_backfill_saved=?, last_backfill_error='' WHERE group_id=?",
        [now(), received, saved, idValue],
      )
      await this.refreshPolicies()
      return {
        requested: limit, received, queued, saved, windowsQueued, sinceAt: sinceAt || 0, reachedSince,
        startedFrom: startCursor,
        // 最旧一条的消息 ID/时间作为续传游标；hasMore 表示按当前游标大概率还有更早历史。
        nextCursor: oldestSeen?.messageId || "",
        nextCursorAt: oldestSeen?.time || 0,
        hasMore: received >= limit && !exhausted && !reachedSince,
      }
    } catch (err) {
      const message = safeError(err)
      // 状态回写失败会让 last_backfill_status 停留在 running，必须记录以便排查；原始错误仍向上抛出。
      await sqliteClient.run(
        "UPDATE group_memory_policies SET last_backfill_at=?, last_backfill_status='failed', last_backfill_error=? WHERE group_id=?",
        [now(), message, idValue],
      ).catch(statusError => this.noteError(statusError))
      await this.refreshPolicies().catch(refreshError => this.noteError(refreshError))
      throw err
    }
  }

  async queueBackfillWindows(scopeType: unknown, scopeId: unknown, timestamps: number[] = []): Promise<number> {
    const policy = this.policies.get(this.key(scopeType, scopeId))
    if (!policy?.enabled) return 0
    const closeBefore = now() - number(groupConfig().windowCloseDelayMinutes, 15, 1, 1440) * 60000
    const starts = [...new Set(timestamps
      .filter(value => Number.isFinite(value) && value > 0)
      .map(value => startOfLocalDay(value))
      .filter(value => dayAfter(value) <= closeBefore))]
      .sort((a, b) => b - a)
      .slice(0, 366)
    let queued = 0
    for (const start of starts) {
      const result = await this.createDailyWindow(scopeType, scopeId, start, dayAfter(start))
      if (result?.queued) queued += 1
    }
    return queued
  }

  async markChangedDailyWindows(_scopeType: unknown, scopeId: unknown, days: number[] = []): Promise<number> {
    const uniqueDays = [...new Set(days.map(value => startOfLocalDay(value)))].filter(Boolean).sort((a, b) => a - b)
    if (!uniqueDays.length) return 0
    const selected = new Set(uniqueDays)
    const rows = await sqliteClient.all(
      `SELECT sent_at, message_id, content_hash
       FROM group_memory_messages
       WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
       ORDER BY sent_at ASC, message_id ASC`,
      [scopeId, uniqueDays[0], dayAfter(uniqueDays.at(-1))],
    )
    const byDay = new Map<number, UnknownRecord[]>()
    for (const row of rows) {
      const start = startOfLocalDay(Number(row.sent_at))
      if (!selected.has(start)) continue
      const list = byDay.get(start) || []
      list.push(row)
      byDay.set(start, list)
    }
    const operations = []
    for (const start of uniqueDays) {
      const end = dayAfter(start)
      const dayRows = byDay.get(start) || []
      if (!dayRows.length) continue
      const currentHash = hash(dayRows.map(row => `${row.message_id}:${row.content_hash}`).join("\n"))
      operations.push({
        sql: "UPDATE group_memory_extraction_jobs SET needs_reextract=1, updated_at=? WHERE group_id=? AND extractor_version=? AND window_start=? AND window_end=? AND status='completed' AND content_hash<>?",
        params: [now(), scopeId, EXTRACTOR_VERSION, start, end, currentHash],
      })
    }
    if (operations.length) await sqliteClient.transaction(operations)
    return operations.length
  }

  async listWindowPage(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue) throw new Error("采集范围和对象 ID 不能为空。")
    const pageSize = integer(options.pageSize, 20, 1, 100)
    const page = integer(options.page, 1, 1, 1000000)
    const total = Number((await sqliteClient.get(
      "SELECT COUNT(*) AS total FROM group_memory_extraction_jobs WHERE group_id=? AND extractor_version=?",
      [idValue, EXTRACTOR_VERSION],
    ))?.total || 0)
    const rows = await sqliteClient.all(`
      WITH page AS (
        SELECT *
        FROM group_memory_extraction_jobs
        WHERE group_id=? AND extractor_version=?
        ORDER BY window_start DESC, id DESC
        LIMIT ? OFFSET ?
      )
      SELECT w.*,
        COUNT(m.id) AS source_message_count,
        COALESCE(SUM(length(m.text_content)), 0) AS source_text_chars,
        COUNT(DISTINCT m.sender_id) AS source_member_count,
        MIN(m.sent_at) AS source_first_at,
        MAX(m.sent_at) AS source_last_at,
        (SELECT m.message_id FROM group_memory_messages m
          WHERE m.group_id = w.group_id
            AND m.sent_at >= w.window_start AND m.sent_at < w.window_end
            AND m.is_command = 0 AND m.text_content <> ''
          ORDER BY m.sent_at ASC, m.message_id ASC LIMIT 1) AS source_first_message_id,
        (SELECT m.message_id FROM group_memory_messages m
          WHERE m.group_id = w.group_id
            AND m.sent_at >= w.window_start AND m.sent_at < w.window_end
            AND m.is_command = 0 AND m.text_content <> ''
          ORDER BY m.sent_at DESC, m.message_id DESC LIMIT 1) AS source_last_message_id
      FROM page w
      LEFT JOIN group_memory_messages m
        ON m.group_id = w.group_id
       AND m.sent_at >= w.window_start AND m.sent_at < w.window_end
       AND m.is_command = 0 AND m.text_content <> ''
      GROUP BY w.id
      ORDER BY w.window_start DESC, w.id DESC
    `, [idValue, EXTRACTOR_VERSION, pageSize, (page - 1) * pageSize])
    const items = rows.map(row => ({
      ...windowView(row),
      chunkCount: Number(windowView(row).modelCallCount || Math.max(0, Math.ceil(Number(row.estimated_input_tokens || 0) / Math.max(1, Number(row.token_limit || 30000))))),
    }))
    return { items, total, page, pageSize }
  }

  async listWindows(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord[]> {
    const page = await this.listWindowPage(scopeType, scopeId, { page: 1, pageSize: number(options.limit, 50, 1, 100) })
    return records(page.items)
  }

  async getWindowDetail(scopeType: unknown, scopeId: unknown, windowId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    const idValueWindow = String(windowId || "").trim()
    if (!type || !idValue || !idValueWindow) throw new Error("缺少提炼任务标识。")
    const row = await sqliteClient.get(`
      SELECT w.*,
        (SELECT COUNT(*) FROM group_memory_messages m
          WHERE m.group_id = w.group_id
            AND m.sent_at >= w.window_start AND m.sent_at < w.window_end
            AND m.is_command = 0 AND m.text_content <> '') AS source_message_count
        ,(SELECT COALESCE(SUM(length(m.text_content)), 0) FROM group_memory_messages m
          WHERE m.group_id = w.group_id
            AND m.sent_at >= w.window_start AND m.sent_at < w.window_end
            AND m.is_command = 0 AND m.text_content <> '') AS source_text_chars
        ,(SELECT COUNT(DISTINCT m.sender_id) FROM group_memory_messages m
          WHERE m.group_id = w.group_id
            AND m.sent_at >= w.window_start AND m.sent_at < w.window_end
            AND m.is_command = 0 AND m.text_content <> '') AS source_member_count
      FROM group_memory_extraction_jobs w
      WHERE w.id=? AND w.group_id=?
    `, [idValueWindow, idValue])
    if (!row) {
      const error = new Error("未找到这个提炼任务。")
      Object.assign(error, { statusCode: 404 })
      throw error
    }
    const totalMessages = Number(row.source_message_count || 0)
    const limit = number(options.limit, 1000, 1, 1000)
    const includeMessages = options.includeMessages !== false
    const [rows, senderRows] = await Promise.all([
      includeMessages
        ? sqliteClient.all(
          `SELECT * FROM group_memory_messages
           WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
           ORDER BY sent_at ASC, message_id ASC LIMIT ?`,
          [idValue, Number(row.window_start), Number(row.window_end), limit],
        )
        : Promise.resolve([]),
      // 结果详情最多只展示一部分原文，但目标成员可能出现在窗口后段；单独取每位发言人的
      // 最近非空名片，兼容旧 result_json 中尚未保存 targetName 的提炼结果。
      sqliteClient.all(
        `SELECT sender_id, sender_name
         FROM group_memory_messages
         WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND sender_id<>'' AND sender_name<>''
         ORDER BY sent_at DESC, message_id DESC`,
        [idValue, Number(row.window_start), Number(row.window_end)],
      ),
    ])
    const targetNames = new Map<string, string>()
    for (const sender of senderRows) {
      const senderId = String(sender.sender_id || "").trim()
      const senderName = cleanText(sender.sender_name || "", 120)
      if (senderId && senderName && !targetNames.has(senderId)) targetNames.set(senderId, senderName)
    }
    const sourceTextChars = Number(row.source_text_chars || 0)
    const sourceMemberCount = Number(row.source_member_count || 0)
    const view = windowView(row, targetNames)
    const policy = this.policies.get(this.key(type, idValue))
    const chunkCount = Number(view.modelCallCount || partitionRowsByTokens(rows, Number(view.tokenLimit || tokenLimit(policy?.tokenLimit))).chunks.length)
    return { window: { ...view, sourceTextChars, sourceMemberCount, chunkCount }, messages: includeMessages ? rows.map(sourceMessageView) : [], totalMessages, truncated: includeMessages && totalMessages > rows.length }
  }

  async listDerivedMemories(scopeType: unknown, scopeId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord[]> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue || type !== "group") throw new Error("第一版仅支持查看指定群的派生记忆。")
    const limit = number(options.limit, 100, 1, 300)
    const rows = await sqliteClient.all(`
      SELECT m.*, GROUP_CONCAT(DISTINCT e.message_id) AS evidence_message_ids
      FROM memory_items m
      LEFT JOIN memory_evidence e ON e.memory_id = m.id
      WHERE ((m.scope_type = 'group' AND m.owner_id = ? AND m.group_id = ?)
        OR (m.scope_type = 'user_group' AND m.group_id = ?)
        OR (m.scope_type = 'user' AND EXISTS (
          SELECT 1 FROM memory_evidence origin
          WHERE origin.memory_id = m.id AND origin.source_type = ?
        )))
        AND NOT (m.type = 'episode' AND m.source = 'interaction')
      GROUP BY m.id
      ORDER BY m.updated_at DESC
      LIMIT ?
    `, [idValue, idValue, idValue, `group-message:${idValue}`, limit])
    return rows.map(row => ({
      id: row.id, scopeType: row.scope_type, ownerId: row.owner_id, groupId: row.group_id, type: row.type,
      text: row.text, tags: parseJson(row.tags_json), status: row.status, source: row.source,
      confidence: Number(row.confidence || 0), importance: Number(row.importance || 0),
      evidenceMessageIds: String(row.evidence_message_ids || "").split(",").filter(Boolean),
      createdAt: Number(row.created_at || 0), updatedAt: Number(row.updated_at || 0), expiresAt: Number(row.expires_at || 0),
    }))
  }

  async duplicateMemoryPlan(scopeType: unknown, scopeId: unknown): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue || type !== "group") throw new Error("第一版仅支持整理指定群的派生记忆。")
    const rows = await sqliteClient.all(`
      SELECT * FROM memory_items
      WHERE ((scope_type='group' AND owner_id=? AND group_id=?) OR (scope_type='user_group' AND group_id=?))
        AND type='fact' AND status IN ('active','warm','cold')
      ORDER BY updated_at DESC
    `, [idValue, idValue, idValue])
    const buckets = new Map<string, UnknownRecord[]>()
    for (const row of rows) {
      if (!isDerivedMemory(row)) continue
      for (const fact of rowFacts(row)) {
        if (!isSingleValueFact(fact.key)) continue
        const key = `${row.scope_type}:${row.owner_id}:${row.group_id}:${factKeyToken(fact.key, fact.value)}`
        const list = buckets.get(key) || []
        list.push(row)
        buckets.set(key, list)
      }
    }
    const entries: UnknownRecord[] = []
    for (const [key, duplicates] of buckets) {
      if (duplicates.length < 2) continue
      const [scopeType, ownerId, groupId, factKey, factValue] = key.split(":")
      const keep = preferredCanonical(duplicates, { factKey, factValue })
      if (!keep) continue
      const archive = duplicates.filter(row => row.id !== keep.id)
      if (!archive.length) continue
      entries.push({ scopeType, ownerId, groupId, factKey, factValue, keep: { id: keep.id, text: keep.text }, archive: archive.map(row => ({ id: row.id, text: row.text })) })
    }
    return { entries, archiveCount: entries.reduce((sum, item) => sum + records(item.archive).length, 0) }
  }

  async mergeDuplicateMemories(scopeType: unknown, scopeId: unknown, ids: unknown[] = []): Promise<UnknownRecord> {
    const plan = await this.duplicateMemoryPlan(scopeType, scopeId)
    const allowed = new Set(records(plan.entries).flatMap(item => records(item.archive).map(row => String(row.id || ""))))
    const requested = [...new Set((Array.isArray(ids) ? ids : []).map(value => String(value)).filter(value => allowed.has(value)))]
    if (!requested.length) return { archived: 0, plan }
    for (const memoryId of requested) await memoryRepository.update(memoryId, { status: "archived", source: "duplicate-merged" })
    await sqliteMemoryStore.refreshStats()
    return { archived: requested.length, plan: await this.duplicateMemoryPlan(scopeType, scopeId) }
  }

  async cleanupExpired(): Promise<UnknownRecord> {
    if (!sqliteClient.status.available) return { messages: 0 }
    const result = await sqliteClient.run("DELETE FROM group_memory_messages WHERE expires_at > 0 AND expires_at <= ?", [now()])
    return { messages: Number(result?.changes || 0) }
  }

  async clear(scopeType: unknown, scopeId: unknown, mode = "raw"): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    if (!type || !idValue || type !== "group") throw new Error("第一版仅支持清理指定群数据。")
    const scopeKey = this.key(type, idValue)
    const result: UnknownRecord & { raw: number; derived: number; windows: number } = { raw: 0, derived: 0, windows: 0 }
    this.clearingScopes.add(scopeKey)
    this.clearEpochs.set(scopeKey, this.clearEpoch(scopeKey) + 1)
    try {
      // 先禁止新事件入队并丢弃尚未落盘的同群事件；若有批量写入在途，等待它结束后
      // 再执行删除，避免清理完成后被延迟 flush 回写。
      this.queue = this.queue.filter(item => this.key(item.scopeType, item.scopeId) !== scopeKey)
      if (this.flushPromise) {
        try { await this.flushPromise } catch { /* 清理仍应继续，失败批次会在下面一并丢弃。 */ }
      }
      this.queue = this.queue.filter(item => this.key(item.scopeType, item.scopeId) !== scopeKey)
      await this.withScopeLock(scopeKey, async () => {
        if (["raw", "all"].includes(mode)) {
          const [raw, windows] = await sqliteClient.transaction([
            { sql: "DELETE FROM group_memory_messages WHERE group_id=?", params: [idValue] },
            { sql: "DELETE FROM group_memory_extraction_jobs WHERE group_id=?", params: [idValue] },
            { sql: "UPDATE group_memory_policies SET last_daily_end=0, updated_at=? WHERE group_id=?", params: [now(), idValue] },
          ])
          result.raw = Number(record(raw).changes || 0)
          result.windows = Number(record(windows).changes || 0)
        }
        if (["derived", "all"].includes(mode)) {
          if (mode === "derived") {
            await sqliteClient.run(
              `UPDATE group_memory_extraction_jobs
               SET status='failed', next_attempt_at=0, processing_chunk=0, processing_chunk_total=0,
                   error_message='管理员已清除派生记忆，可按需重新提炼', updated_at=?
               WHERE group_id=? AND status IN ('pending', 'running')`,
              [now(), idValue],
            )
          }
          result.derived = await memoryRepository.hardDeleteGroup(idValue, { includeInteraction: mode === "all" })
          // 群名片记忆已随本群删除，失效缓存以便重新采集时重建。
          for (const key of [...this.identityCache.keys()]) {
            if (key.includes(`:${idValue}:`)) this.identityCache.delete(key)
          }
          await sqliteMemoryStore.refreshStats()
        }
      })
      await this.refreshPolicies()
      return result
    } finally {
      this.clearingScopes.delete(scopeKey)
    }
  }

  async createDailyWindow(scopeType: unknown, scopeId: unknown, windowStart: number, windowEnd: number, options: UnknownRecord = {}): Promise<DailyWindowResult | null> {
    const rows = await sqliteClient.all(
      `SELECT message_id, sender_id, sender_name, sent_at, text_content, content_hash
       FROM group_memory_messages
       WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
       ORDER BY sent_at ASC, message_id ASC`,
      [scopeId, windowStart, windowEnd],
    )
    if (!rows.length) return null
    const policy = this.policies.get(this.key(scopeType, scopeId))
    const limit = tokenLimit(policy?.tokenLimit)
    const partition = partitionRowsByTokens(rows, limit)
    const contentHash = hash(rows.map(row => `${row.message_id}:${row.content_hash}`).join("\n"))
    const timestamp = now()
    const existing = await sqliteClient.get(
      `SELECT id, status, content_hash FROM group_memory_extraction_jobs
       WHERE group_id=? AND window_start=? AND window_end=? AND extractor_version=?
       ORDER BY updated_at DESC LIMIT 1`,
      [scopeId, windowStart, windowEnd, EXTRACTOR_VERSION],
    )
    if (existing && existing.content_hash !== contentHash && !options.requeue) {
      if (String(existing.status || "") === "completed") {
        await sqliteClient.run("UPDATE group_memory_extraction_jobs SET needs_reextract=1, updated_at=? WHERE id=?", [timestamp, existing.id])
      }
      return { rows, contentHash, queued: false, changed: true, partition }
    }
    if (existing && options.requeue) {
      if (["pending", "running"].includes(String(existing.status || ""))) return { rows, contentHash, queued: false, partition }
      await sqliteClient.run(
        `UPDATE group_memory_extraction_jobs SET content_hash=?, status='pending', attempt_count=0, next_attempt_at=0, needs_reextract=0,
          processing_chunk=0, processing_chunk_total=0,
          token_limit=?, estimated_input_tokens=?, skipped_message_count=?, error_message='', result_json='[]', completed_at=0, updated_at=? WHERE id=?`,
        [contentHash, limit, partition.estimatedTokens, partition.skipped.length, timestamp, existing.id],
      )
      return { rows, contentHash, queued: true, partition }
    }
    const inserted = await sqliteClient.run(
      `INSERT OR IGNORE INTO group_memory_extraction_jobs(id, group_id, window_start, window_end, content_hash, extractor_version, status, attempt_count, next_attempt_at, token_limit, estimated_input_tokens, skipped_message_count, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, ?, ?)`,
      [id(), scopeId, windowStart, windowEnd, contentHash, EXTRACTOR_VERSION, limit, partition.estimatedTokens, partition.skipped.length, timestamp, timestamp],
    )
    let queued = Number(inserted?.changes || 0) > 0
    if (options.requeue && !queued) {
      const current = await sqliteClient.get(
        `SELECT id, status FROM group_memory_extraction_jobs
         WHERE group_id=? AND window_start=? AND window_end=? AND extractor_version=?
         ORDER BY updated_at DESC LIMIT 1`,
        [scopeId, windowStart, windowEnd, EXTRACTOR_VERSION],
      )
      if (current && !["pending", "running"].includes(String(current.status || ""))) {
        await sqliteClient.run(
          `UPDATE group_memory_extraction_jobs SET status='pending', attempt_count=0, next_attempt_at=0, needs_reextract=0,
            processing_chunk=0, processing_chunk_total=0, token_limit=?, estimated_input_tokens=?, skipped_message_count=?, error_message='', result_json='[]', completed_at=0, updated_at=? WHERE id=?`,
          [limit, partition.estimatedTokens, partition.skipped.length, timestamp, current.id],
        )
        queued = true
      }
    }
    return { rows, contentHash, queued, partition }
  }

  async messageDayStarts(scopeId: unknown, options: UnknownRecord = {}): Promise<number[]> {
    const startAt = Math.max(0, Number(options.startAt || 0))
    const endAt = Math.max(startAt, Number(options.endAt || now()))
    const limit = integer(options.limit, 366, 1, 3660)
    const direction = options.descending ? "DESC" : "ASC"
    // SQLite localtime 与同一进程里的 startOfLocalDay 使用相同系统时区；先按本地日期
    // 聚合为每个有文本消息的自然日，再由 JS 规范到该日零点，夏令时日仍保持 23/25 小时语义。
    const rows = await sqliteClient.all(
      `SELECT MIN(sent_at) AS sample_at
       FROM group_memory_messages
       WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
       GROUP BY strftime('%Y-%m-%d', sent_at / 1000, 'unixepoch', 'localtime')
       ORDER BY sample_at ${direction}
       LIMIT ?`,
      [scopeId, startAt, endAt, limit],
    )
    return rows.map(row => startOfLocalDay(Number(row.sample_at))).filter(Boolean)
  }

  // 仅在隔天后提炼：今天任何时刻的扫描，最多只会把昨天及更早的自然日入队。
  async scheduleClosedWindows(): Promise<void> {
    const closeBefore = now() - number(groupConfig().windowCloseDelayMinutes, 15, 1, 1440) * 60000
    for (const policy of this.policies.values()) {
      if (!policy.enabled || policy.scopeType !== "group") continue
      let cursor = policy.lastDailyEnd
      if (!cursor) {
        const first = await sqliteClient.get("SELECT MIN(sent_at) AS sent_at FROM group_memory_messages WHERE group_id=?", [policy.scopeId])
        if (!Number(first?.sent_at)) continue
        cursor = startOfLocalDay(Number(first?.sent_at))
      }
      const boundary = startOfLocalDay(closeBefore)
      let scanEnd = cursor
      let processed = 0
      while (processed < 366) {
        const end = dayAfter(scanEnd)
        // end <= cursor 属时间计算异常（如时钟回拨），必须退出以防游标停滞导致死循环。
        if (end > boundary || end <= scanEnd) break
        scanEnd = end
        processed += 1
      }
      if (scanEnd > cursor) {
        const starts = await this.messageDayStarts(policy.scopeId, { startAt: cursor, endAt: scanEnd, limit: 366 })
        for (const start of starts) {
          await this.createDailyWindow(policy.scopeType, policy.scopeId, start, dayAfter(start))
        }
        cursor = scanEnd
      }
      if (cursor !== policy.lastDailyEnd) {
        await sqliteClient.run("UPDATE group_memory_policies SET last_daily_end=?, updated_at=? WHERE group_id=?", [cursor, now(), policy.scopeId])
        policy.lastDailyEnd = cursor
      }
    }
  }

  async queueNow(scopeType: unknown, scopeId: unknown): Promise<UnknownRecord[]> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy?.enabled) throw new Error("请先开启这个群的消息采集。")
    // 手动扫描也只入队最近一个已关闭自然日，不触发当天提炼。
    const end = startOfLocalDay(now())
    const start = startOfLocalDay(end - 1)
    await this.drain()
    await this.createDailyWindow(type, idValue, start, end)
    return this.listWindows(type, idValue, { limit: 1 })
  }

  async queueExtraction(scopeType: unknown, scopeId: unknown): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy?.enabled) throw new Error("请先开启这个群的消息采集。")
    await this.drain()
    const closedBefore = startOfLocalDay(now())
    const starts = await this.messageDayStarts(idValue, { startAt: 0, endAt: closedBefore, limit: 366, descending: true })
    const historicalDays = await this.queueBackfillWindows(type, idValue, starts)
    const latest = await this.queueNow(type, idValue)
    const timer = setTimeout(() => {
      this.processDueWindows().catch(err => this.noteError(err))
    }, 0)
    timer.unref?.()
    return { historicalDays, latest }
  }

  async runWindow(scopeType: unknown, scopeId: unknown, windowId: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const type = normalizeScopeType(scopeType)
    const idValue = String(scopeId || "").trim()
    const idValueWindow = String(windowId || "").trim()
    if (type !== "group" || !idValue || !idValueWindow) throw new Error("缺少提炼任务标识。")
    const policy = this.policies.get(this.key(type, idValue))
    if (!policy?.enabled) throw new Error("请先开启这个群的消息采集。")
    if (record(groupConfig().consolidation).enabled === false) throw new Error("记忆提炼功能当前已关闭，请先在全局设置中开启。")
    await this.drain()
    const row = await sqliteClient.get(
      `SELECT * FROM group_memory_extraction_jobs
       WHERE id=? AND group_id=? AND extractor_version=?`,
      [idValueWindow, idValue, EXTRACTOR_VERSION],
    )
    if (!row) {
      const error = new Error("未找到这个提炼任务。")
      Object.assign(error, { statusCode: 404 })
      throw error
    }
    const status = String(row.status || "")
    const retry = status === "failed" || (status === "completed" && Boolean(row.needs_reextract))
    if (status === "running") {
      const error = new Error("这个提炼任务正在运行中，请等待当前任务完成。")
      Object.assign(error, { statusCode: 409 })
      throw error
    }
    if ((options.retry === true && !retry) || (!retry && status !== "pending")) {
      const error = new Error("只有等待处理的任务可以立即执行；已完成任务无需重复执行。")
      Object.assign(error, { statusCode: 409 })
      throw error
    }
    const source = await sqliteClient.get(
      `SELECT COUNT(*) AS count
       FROM group_memory_messages
       WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''`,
      [idValue, Number(row.window_start), Number(row.window_end)],
    )
    if (!Number(source?.count || 0)) throw new Error("这个提炼任务的原始消息已过期或不存在，无法执行。")
    const runKey = `${type}:${idValue}:${idValueWindow}`
    if (this.manualWindowRuns.has(runKey)) {
      const error = new Error("这个提炼任务已经提交手动执行，请等待状态刷新。")
      Object.assign(error, { statusCode: 409 })
      throw error
    }
    const timestamp = now()
    await sqliteClient.run(
      `UPDATE group_memory_extraction_jobs
       SET status='pending', next_attempt_at=0, processing_chunk=0, processing_chunk_total=?,
           attempt_count=?, needs_reextract=0, error_message=?, result_json=?, completed_at=0, updated_at=?
       WHERE id=?`,
      [retry ? 0 : Number(row.processing_chunk_total || 0), retry ? 0 : Number(row.attempt_count || 0), retry ? "" : String(row.error_message || ""), retry ? "[]" : String(row.result_json || "[]"), timestamp, idValueWindow],
    )
    const queuedRow = {
      ...row,
      status: "pending",
      next_attempt_at: 0,
      processing_chunk: 0,
      processing_chunk_total: retry ? 0 : Number(row.processing_chunk_total || 0),
      attempt_count: retry ? 0 : Number(row.attempt_count || 0),
      needs_reextract: 0,
      error_message: retry ? "" : String(row.error_message || ""),
      result_json: retry ? "[]" : String(row.result_json || "[]"),
      completed_at: 0,
      updated_at: timestamp,
    }
    this.manualWindowRuns.add(runKey)
    const launch = (delayMs = 0) => {
      const timer = setTimeout(() => {
        void (async () => {
          const current = await sqliteClient.get(
            "SELECT * FROM group_memory_extraction_jobs WHERE id=? AND group_id=? AND extractor_version=?",
            [idValueWindow, idValue, EXTRACTOR_VERSION],
          )
          if (!current || String(current.status || "") !== "pending") {
            this.manualWindowRuns.delete(runKey)
            return
          }
          if (this.processing) {
            // 模型调用可能持续数十秒，避免 0ms 定时器反复查询 SQLite。
            launch(250)
            return
          }
          this.processing = true
          try {
            await this.processWindow({ ...current, next_attempt_at: 0 })
          } catch (error) {
            this.noteError(error)
          } finally {
            this.processing = false
            this.manualWindowRuns.delete(runKey)
          }
        })().catch(error => {
          this.manualWindowRuns.delete(runKey)
          this.noteError(error)
        })
      }, delayMs)
      timer.unref?.()
    }
    launch()
    return { queued: true, retried: retry, window: windowView(queuedRow) }
  }

  async scan(): Promise<void> {
    if (!sqliteClient.status.available || groupConfig().enabled === false) return
    await this.drain()
    await this.cleanupExpired()
    await sqliteClient.run("UPDATE group_memory_extraction_jobs SET status='pending', next_attempt_at=0, processing_chunk=0, processing_chunk_total=0, updated_at=? WHERE status='running' AND updated_at < ?", [now(), now() - 10 * 60000])
    await this.scheduleClosedWindows()
    await this.processDueWindows()
  }

  // 暂停采集的群保留已排队任务但不处理，重新开启后继续，不白耗模型调用。
  async processDueWindows(): Promise<void> {
    const consolidation = record(groupConfig().consolidation)
    if (consolidation.enabled === false || this.processing || !sqliteClient.status.available) return
    this.processing = true
    try {
      const rows = await sqliteClient.all(
        `SELECT w.*,
          (SELECT COUNT(*) FROM group_memory_messages m
            WHERE m.group_id=w.group_id AND m.sent_at>=w.window_start AND m.sent_at<w.window_end
              AND m.is_command=0 AND m.text_content<>'') AS source_message_count,
          (SELECT COALESCE(SUM(length(m.text_content)), 0) FROM group_memory_messages m
            WHERE m.group_id=w.group_id AND m.sent_at>=w.window_start AND m.sent_at<w.window_end
              AND m.is_command=0 AND m.text_content<>'') AS source_text_chars
         FROM group_memory_extraction_jobs w
         WHERE w.status='pending' AND w.extractor_version=? AND w.next_attempt_at<=?
           AND EXISTS (SELECT 1 FROM group_memory_policies p WHERE p.group_id=w.group_id AND p.enabled=1)
         ORDER BY w.group_id ASC, w.window_start ASC
         LIMIT 64`,
        [EXTRACTOR_VERSION, now()],
      )
      for (const row of rows.slice(0, integer(consolidation.maxWindowsPerScan, 2, 1, 64))) await this.processWindow(row)
    } finally {
      this.processing = false
    }
  }

  async processWindow(window: UnknownRecord = {}): Promise<void> {
    if (!window?.id) return
    const config = groupConfig()
    const consolidation = record(config.consolidation)
    const first = window
    const scopeKey = this.key("group", first.group_id)
    const clearEpoch = this.clearEpoch(scopeKey)
    const policy = this.policies.get(this.key("group", window.group_id))
    const modelName = String(policy?.modelName || "").trim()
    const attempts = Number(window.attempt_count || 0) + 1
    try {
      if (modelName) selectedChatModel(modelName)
      const sourceRows = await sqliteClient.all(
        `SELECT id, message_id, sender_id, sender_name, sender_role, sent_at,
                text_content, segments_json, content_hash, conflict_count
         FROM group_memory_messages
         WHERE group_id=? AND sent_at>=? AND sent_at<? AND is_command=0 AND text_content<>''
         ORDER BY sent_at ASC, message_id ASC`,
        [first.group_id, first.window_start, first.window_end],
      )
      const partition = partitionRowsByTokens(sourceRows, Number(first.token_limit) || tokenLimit(policy?.tokenLimit))
      const chunks = partition.chunks
      const batchTextChars = sourceRows.reduce((sum, row) => sum + String(row.text_content || "").length, 0)
      // 完成时回写实际处理内容的哈希（与 createDailyWindow/markChangedDailyWindows 同一公式）：
      // pending 期间补录进来的消息已被本次提炼覆盖，不应再被旧哈希误判为“需重提炼”。
      const processedHash = hash(sourceRows.map(row => `${row.message_id}:${row.content_hash}`).join("\n"))
      if (clearEpoch !== this.clearEpoch(scopeKey)) return
      await sqliteClient.run(
        `UPDATE group_memory_extraction_jobs SET status='running', attempt_count=?, processing_chunk=0, processing_chunk_total=?, token_limit=?, estimated_input_tokens=?, skipped_message_count=?, needs_reextract=0, updated_at=? WHERE id=?`,
        [attempts, chunks.length, Number(first.token_limit) || tokenLimit(policy?.tokenLimit), partition.estimatedTokens, partition.skipped.length, now(), first.id],
      )
      if (!sourceRows.length || !chunks.length) {
        await sqliteClient.run(
          "UPDATE group_memory_extraction_jobs SET status='completed', content_hash=?, processing_chunk=0, processing_chunk_total=0, result_json=?, error_message='', completed_at=?, updated_at=? WHERE id=?",
          [processedHash, JSON.stringify({ items: [], modelCallCount: 0, messageCount: sourceRows.length, textChars: batchTextChars, skippedMessageCount: partition.skipped.length }), now(), now(), first.id],
        )
        return
      }
      const candidates: UnknownRecord[] = []
      const consolidationMaxTokens = integer(policy?.maxTokens, integer(consolidation.maxTokens, 4096, 256, 65536), 256, 65536)
      for (let index = 0; index < chunks.length; index += 1) {
        if (clearEpoch !== this.clearEpoch(scopeKey)) return
        const chunk = chunks[index]
        await sqliteClient.run("UPDATE group_memory_extraction_jobs SET processing_chunk=?, processing_chunk_total=?, updated_at=? WHERE id=?", [index + 1, chunks.length, now(), first.id])
      const result = await runIsolatedModelTask({
          taskName: String(consolidation.taskName || "replyer"),
          channelId: modelName || undefined,
          systemPrompt: EXTRACTOR_SYSTEM,
          prompt: extractionPrompt(first.group_id, { window_start: first.window_start, window_end: first.window_end }, chunk, policy?.promptTemplate),
          maxTokens: consolidationMaxTokens,
          timeoutMs: 90000,
          source: "group-memory-consolidation",
          purpose: "memory-consolidation",
          event: { group_id: first.group_id, isGroup: true, user_id: "memory-consolidator" },
          metadata: { memoryExtraction: { groupId: first.group_id, windowId: first.id } },
          snapshotMetadata: { memoryExtraction: { groupId: first.group_id, windowId: first.id } },
        })
        if (clearEpoch !== this.clearEpoch(scopeKey)) return
        const payload = modelJson(result.text)
        // 解析失败必须抛错走既有重试/failed 路径，不能静默当作“无事实”完成；
        // 错误信息不携带模型原文，error_message 会持久化并在管理台展示。
        if (!payload || !Array.isArray(payload.candidates)) {
          // 推理型模型的思考 token 计入输出上限，撞顶截断是 JSON 不完整的最常见原因，直接在错误里给出处置提示。
          const truncated = Number(record(result.usage).output || 0) >= consolidationMaxTokens
          throw new Error(`第 ${index + 1}/${chunks.length} 个子窗口未返回可解析的 candidates JSON（返回文本 ${String(result.text || "").length} 字符${truncated ? `；模型输出达到 ${consolidationMaxTokens} Token 上限被截断，请调大系统默认或该群的输出 Token 上限` : ""}）`)
        }
        candidates.push(...records(payload.candidates))
      }
      await this.withScopeLock(scopeKey, async () => {
        if (clearEpoch !== this.clearEpoch(scopeKey)) return
        const applied = await this.applyCandidates(first, sourceRows, candidates, { isCurrent: () => clearEpoch === this.clearEpoch(scopeKey) })
        if (clearEpoch !== this.clearEpoch(scopeKey)) return
        const completedAt = now()
        const resultJson = serializeExtractionResult({
          items: applied,
          modelCallCount: chunks.length,
          messageCount: sourceRows.length,
          textChars: batchTextChars,
          estimatedInputTokens: partition.estimatedTokens,
          skippedMessageCount: partition.skipped.length,
        })
        await sqliteClient.run(
          "UPDATE group_memory_extraction_jobs SET status='completed', content_hash=?, processing_chunk=0, processing_chunk_total=0, result_json=?, error_message='', completed_at=?, updated_at=? WHERE id=?",
          [processedHash, resultJson, completedAt, completedAt, first.id],
        )
      })
    } catch (err) {
      if (clearEpoch !== this.clearEpoch(scopeKey)) return
      const limit = number(consolidation.maxAttempts, 3, 1, 20)
      const retry = attempts < limit
      const delay = Math.min(60 * 60000, 5 * 60000 * 2 ** Math.max(0, attempts - 1))
      await sqliteClient.run(
        "UPDATE group_memory_extraction_jobs SET status=?, attempt_count=?, next_attempt_at=?, processing_chunk=0, processing_chunk_total=0, error_message=?, updated_at=? WHERE id=?",
        [retry ? "pending" : "failed", attempts, retry ? now() + delay : 0, safeError(err), now(), first.id],
      )
      this.noteError(err)
    }
  }

  async applyCandidates(window: UnknownRecord = {}, sourceRows: UnknownRecord[] = [], candidates: UnknownRecord[] = [], options: ExtractionOptions = {}): Promise<UnknownRecord[]> {
    // expiryFor 读取 memory.retention，必须传完整配置快照而不是 groupCapture 子树。
    const config = configStore.get()
    const policy = this.policies.get(this.key("group", window.group_id))
    const minConfidence = number(policy?.minConfidence, number(record(groupConfig().consolidation).minConfidence, 0.7, 0, 1), 0, 1)
    const byMessageId = new Map<string, UnknownRecord>(sourceRows.map(row => [String(row.message_id), row]))
    const merged = new Map<string, Candidate>()
    for (const source of Array.isArray(candidates) ? candidates : []) {
      const raw = source as Candidate
      const rawScope = String(raw?.scope || "")
      // 兼容旧提示词把 episode 错放进 scope 的返回；新协议只允许三种真实作用域。
      const scope = rawScope === "episode" ? "group" : rawScope
      const kind = rawScope === "episode" ? "episode" : cleanText(raw?.kind || "fact", 48).toLowerCase()
      const rawOperation = String(raw?.operation || "add").toLowerCase()
      // 未知 operation 维持旧行为按 add 处理，retract 单独走撤回路径。
      const operation = rawOperation === "retract" ? "retract" : "add"
      const text = cleanText(raw?.text || "", 500)
      const evidenceIds = [...new Set((Array.isArray(raw?.evidenceMessageIds) ? raw.evidenceMessageIds : []).map(value => String(value)).filter(value => byMessageId.has(value)))].slice(0, 8)
      if (!text || !evidenceIds.length || rawOperation === "ignore" || !["user", "user_group", "group"].includes(scope)) continue
      const subjectId = String(raw?.subjectId || "").trim()
      const speakerId = String(raw?.speakerId || "").trim()
      const evidence = evidenceIds.map(messageId => byMessageId.get(messageId)).filter((row): row is UnknownRecord => Boolean(row))
      if (["user", "user_group"].includes(scope) && (!subjectId || !evidence.some(row => String(row.sender_id) === subjectId) || (speakerId && speakerId !== subjectId))) continue
      const groupEvidenceIsAuthoritative = evidence.some(row => ["owner", "admin"].includes(String(row.sender_role || "").toLowerCase()))
      if (scope === "group" && new Set(evidence.map(row => String(row.sender_id))).size < 2 && !groupEvidenceIsAuthoritative) continue
      if (String(raw?.sensitivity || "normal") === "sensitive") continue
      // sensitivity 是不可信的模型输出；候选正文和值都必须再次经过服务端策略。
      try { validateMemoryWrite(`${text} ${cleanText(raw?.factValue || "", 500)}`, { source: "group-window" }) } catch { continue }
      // 缺省 confidence 按 0.7 计并用严格小于比较：默认阈值 0.7 下不影响未自报置信度的候选。
      if (number(raw?.confidence, 0.7, 0, 1) < minConfidence) continue
      const ownerKey = scope === "group" ? window.group_id : subjectId
      const groupKey = scope === "user_group" || scope === "group" ? window.group_id : ""
      if (operation === "retract") {
        // 撤回候选跳过 candidateAtoms：身份归一化会把“否定旧事实”的文本误改写成新自述。
        const factKey = canonicalFactKey(raw?.factKey || "")
        if (!factKey) continue
        const factValue = cleanText(raw?.factValue || "", 160)
        const key = `${operation}:${scope}:${ownerKey}:${groupKey}:${factKeyToken(factKey, factValue)}`
        const current = merged.get(key) || { operation, scope, kind, text, subjectId, factKey, factValue, evidenceIds: [], evidence: [] }
        current.evidenceIds = [...new Set([...(current.evidenceIds || []), ...evidenceIds])].slice(0, 12)
        current.evidence = [...new Map([...(current.evidence || []), ...evidence].map(row => [row.id, row])).values()]
        merged.set(key, current)
        continue
      }
      for (const atom of candidateAtoms({ ...raw, text, kind }, evidence, scope)) {
        let clean
        // 写入策略拒绝（如包含凭证类文本）是预期的过滤路径，直接丢弃该候选即可。
        try { clean = validateMemoryWrite(atom.text, { source: "group-window" }) } catch { continue }
        const factKey = cleanText(atom.factKey || genericFactKey(atom.kind, clean), 180)
        const factValue = cleanText(atom.factValue || normalizedFactValue(clean, 160), 160)
        if (!factKey || !factValue) continue
        // key 带 operation 维度，避免同槽位的 add 与 retract 互相合并覆盖。
        const key = `${operation}:${scope}:${ownerKey}:${groupKey}:${factKeyToken(factKey, factValue)}`
        const current = merged.get(key) || { ...atom, operation, scope, text: clean, subjectId, factKey, factValue, evidenceIds: [], evidence: [] }
        current.evidenceIds = [...new Set([...(current.evidenceIds || []), ...evidenceIds])].slice(0, 12)
        current.evidence = [...new Map([...(current.evidence || []), ...evidence].map(row => [row.id, row])).values()]
        merged.set(key, current)
      }
    }
    // batchFactTokens 表示本批“断言存在”的事实，撤回候选不参与该集合。
    const batchFactTokens = new Set([...merged.values()].filter(candidate => candidate.operation !== "retract").map(candidate => factKeyToken(candidate.factKey, candidate.factValue)))
    const cachedRows = new Map<string, UnknownRecord[]>()
    const rowsFor = async (scope: MemoryScope): Promise<UnknownRecord[]> => {
      const cacheKey = `${scope.scopeType}:${scope.ownerId}:${scope.groupId}`
      if (!cachedRows.has(cacheKey)) cachedRows.set(cacheKey, await memoryRepository.list([scope], { limit: 500, includeCold: true }))
      return cachedRows.get(cacheKey) || []
    }
    const applied: UnknownRecord[] = []
    const targetNames = new Map<string, string>()
    for (const source of sourceRows) {
      const senderId = String(source.sender_id || "").trim()
      const senderName = cleanText(source.sender_name || "", 120)
      if (senderId && senderName && !targetNames.has(senderId)) targetNames.set(senderId, senderName)
    }
    for (const candidate of merged.values()) {
      if (typeof options.isCurrent === "function" && !options.isCurrent()) return applied
      const candidateText = String(candidate.text || "")
      const candidateFactKey = String(candidate.factKey || "")
      const candidateFactValue = String(candidate.factValue || "")
      const candidateEvidence: UnknownRecord[] = candidate.evidence || []
      const scope: MemoryScope = candidate.scope === "user"
        ? { scopeType: "user", ownerId: String(candidate.subjectId || ""), groupId: "" }
        : candidate.scope === "user_group"
          ? { scopeType: "user_group", ownerId: String(candidate.subjectId || ""), groupId: String(window.group_id || "") }
          : { scopeType: "group", ownerId: String(window.group_id || ""), groupId: String(window.group_id || "") }
      const type = candidate.kind === "episode" ? "episode" : "fact"
      const existingRows = await rowsFor(scope)
      // rowsFor 的候选集有 500 条上限；按 fact_key 精确补查（走 memory_items_fact_identity_idx），
      // 避免超大作用域下同槽位旧记忆不在候选集内造成重复插入或漏修订。
      for (const row of await memoryRepository.listByFactKey(scope, candidate.factKey)) {
        if (!existingRows.some(item => item.id === row.id)) existingRows.push(row)
      }
      if (candidate.operation === "retract") {
        const retractValue = normalizedFactValue(candidate.factValue)
        // 只撤回本管线派生的行；管理员手工维护的记忆不受模型撤回影响。
        const targets = existingRows.filter(row => isDerivedMemory(row)
          && rowFacts(row).some(fact => fact.key === candidate.factKey && (!retractValue || normalizedFactValue(String(fact.value)) === retractValue)))
        const archivedIds = []
        for (const row of targets) {
          if (typeof options.isCurrent === "function" && !options.isCurrent()) return applied
          // 归档复用既有 superseded 语义，隐私清理 hardDeleteGroup 已覆盖该来源。
          await memoryRepository.update(row.id, { status: "archived", source: "superseded" })
          for (const source of candidateEvidence) {
            await memoryRepository.addEvidence(row.id, {
              messageId: source.message_id,
              sourceEventId: source.id,
              sourceType: `group-message:${window.group_id}`,
            })
          }
          const index = existingRows.findIndex(item => item.id === row.id)
          if (index >= 0) existingRows.splice(index, 1)
          archivedIds.push(row.id)
        }
        applied.push({
          id: archivedIds[0] || `retract:${scope.scopeType}:${scope.ownerId}:${factKeyToken(candidate.factKey, candidate.factValue)}`,
          scopeType: scope.scopeType, ownerId: scope.ownerId, type, text: candidate.text,
          factKey: candidate.factKey, factValue: candidate.factValue,
          action: archivedIds.length ? "retracted" : "ignored",
          ...(archivedIds.length ? { retractedCount: archivedIds.length } : { reason: "没有可撤回的同槽位派生记忆" }),
          evidenceCount: candidateEvidence.length, evidenceMessageIds: candidateEvidence.map(row => row.message_id),
        })
        continue
      }
      const sameValueRows = existingRows.filter(row => row.type === type && rowFacts(row).some(fact => fact.key === candidate.factKey && String(fact.value) === String(candidate.factValue)))
      const sameSlotRows = existingRows.filter(row => row.type === type && rowFacts(row).some(fact => fact.key === candidate.factKey))
      const same = preferredCanonical(sameValueRows, candidate)
      const conflict = !same && isSingleValueFact(candidate.factKey)
        ? preferredCanonical(sameSlotRows.filter(row => !rowFacts(row).some(fact => fact.key === candidate.factKey && String(fact.value) === String(candidate.factValue))), candidate)
        : null
      const validTo = parseMoment(candidate.validTo)
      if (conflict && !isDerivedMemory(conflict)) {
        applied.push({
          id: conflict.id, scopeType: scope.scopeType, ownerId: scope.ownerId, type, text: candidateText,
          factKey: candidateFactKey, factValue: candidateFactValue, action: "ignored", reason: "已保留管理员维护的同类记忆", evidenceCount: candidateEvidence.length, evidenceMessageIds: candidateEvidence.map(row => row.message_id),
        })
        continue
      }
      let action = "added"
      let duplicateCount = 0
      let memory
      const evidence = candidateEvidence.map(source => ({
        messageId: source.message_id,
        sourceEventId: source.id,
        sourceType: `group-message:${window.group_id}`,
      }))
      const windowSource = `group-window:${window.id}`
      if (same) {
        action = "reinforced"
        const normalizeExisting = isDerivedMemory(same) && rowFacts(same).length > 1
        const evidenceIds = evidence.map(item => item.sourceEventId)
        const placeholders = evidenceIds.map(() => "?").join(",")
        const appliedEvidence = evidenceIds.length
          ? Number((await sqliteClient.get(
            `SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id=? AND source_event_id IN (${placeholders})`,
            [same.id, ...evidenceIds],
          ))?.count || 0)
          : 0
        // 完成状态回写失败后同一窗口会重试。证据与记忆更新在一个事务中；若这些证据
        // 已全部存在，说明该候选已经应用过，不能再次强化置信度。
        if (evidenceIds.length && appliedEvidence === evidenceIds.length) {
          memory = same
        } else {
          memory = await memoryRepository.update(same.id, {
            factKey: candidateFactKey, factValue: candidateFactValue,
            ...(normalizeExisting ? { text: candidateText, normalized: candidateText.toLowerCase() } : {}),
            lastConfirmedAt: now(), status: "active", source: isDerivedMemory(same) ? windowSource : String(same.source || windowSource),
            confidence: Math.min(1, Number(same.confidence || 0.7) + 0.04),
          }, { evidence })
        }
        for (const duplicate of sameValueRows) {
          if (duplicate.id === same.id || !isDerivedMemory(duplicate) || !factsCoveredByBatch(duplicate, batchFactTokens)) continue
          await memoryRepository.update(duplicate.id, { status: "archived", source: "duplicate-merged" })
          const index = existingRows.findIndex(row => row.id === duplicate.id)
          if (index >= 0) existingRows.splice(index, 1)
          duplicateCount += 1
        }
      } else if (conflict) {
        action = "updated"
        await memoryRepository.update(conflict.id, { status: "archived", source: "superseded" })
        const index = existingRows.findIndex(row => row.id === conflict.id)
        if (index >= 0) existingRows.splice(index, 1)
        memory = await memoryRepository.insert({
          ...scope,
          type,
          text: candidateText,
          normalized: candidateText.toLowerCase(),
          factKey: candidateFactKey,
          factValue: candidateFactValue,
          tags: ["group-capture", cleanText(candidate.kind || type, 48)].filter(Boolean),
          importance: number(candidate.importance, type === "episode" ? 0.4 : 0.62, 0, 1),
          confidence: number(candidate.confidence, 0.7, 0, 1),
          source: windowSource,
          expiresAt: validTo > now() ? validTo : type === "episode" ? expiryFor("episode", config) : 0,
        }, { evidence })
      } else {
        memory = await memoryRepository.insert({
          ...scope,
          type,
          text: candidateText,
          normalized: candidateText.toLowerCase(),
          factKey: candidateFactKey,
          factValue: candidateFactValue,
          tags: ["group-capture", cleanText(candidate.kind || type, 48)].filter(Boolean),
          importance: number(candidate.importance, type === "episode" ? 0.4 : 0.62, 0, 1),
          confidence: number(candidate.confidence, 0.7, 0, 1),
          source: windowSource,
          expiresAt: validTo > now() ? validTo : type === "episode" ? expiryFor("episode", config) : 0,
        }, { evidence })
      }
      if (!memory) continue
      if (!existingRows.some(row => row.id === memory.id)) existingRows.push(memory)
      applied.push({ id: memory.id, scopeType: scope.scopeType, ownerId: scope.ownerId, type, text: memory.text, factKey: candidateFactKey, factValue: candidateFactValue, action, duplicateCount, evidenceCount: candidateEvidence.length, evidenceMessageIds: candidateEvidence.map(row => row.message_id) })
    }
    if (applied.length) await sqliteMemoryStore.refreshStats()
    return resultItemsWithTargetNames(applied, targetNames)
  }

  async summary(options: UnknownRecord = {}): Promise<UnknownRecord> {
    if (!sqliteClient.status.available) {
      return { available: false, initialized: false, pendingMessages: 0, lastError: sqliteClient.status.error || "SQLite 不可用", policies: [], windows: {} }
    }
    const policies = await this.listPolicies({ includeMessageStats: options.includeMessageStats !== false })
    const windows = await sqliteClient.all(
      "SELECT status, COUNT(*) AS count FROM group_memory_extraction_jobs WHERE extractor_version=? GROUP BY status",
      [EXTRACTOR_VERSION],
    )
    return {
      available: Boolean(sqliteClient.status.available),
      initialized: this.initialized,
      pendingMessages: this.queue.length,
      lastError: this.lastError,
      defaultPromptTemplate: DEFAULT_GROUP_MEMORY_PROMPT,
      defaultPolicy: policyDefaults(),
      historyBackfillMaxMessages: integer(groupConfig().historyBackfillMaxMessages, 500, 1, 5000),
      policies,
      windows: Object.fromEntries(windows.map(row => [row.status, Number(row.count || 0)])),
    }
  }

  stats() {
    return {
      initialized: this.initialized,
      policies: this.policies.size,
      pendingMessages: this.queue.length,
      processing: this.processing,
      lastError: this.lastError,
    }
  }
}

export const groupCaptureStore = new GroupCaptureStore()
