import { createHash } from "node:crypto"
import { configStore } from "../../config/store.js"
import type { RuntimeConfigObject } from "../../config/types.js"
import { errorDetails, errorSummary, redactErrorText } from "../../core/shared/error-details.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { buildStickerChannelArguments, projectStickerChannelOutput } from "../../core/persona/sticker-channel-adapter.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"
import { getToolCommon } from "../support/contract.js"

type UnknownRecord = Record<string, unknown>

interface StickerExpressionContext extends ToolExecutionContext {
  config?: RuntimeConfigObject
  e?: UnknownRecord
  toolConfig?: UnknownRecord
}

export interface StickerCandidate {
  id: string
  url: string
  description: string
  tags: string[]
  score: number | null
  matchScore: number
}

interface StickerBinding {
  serverName: string
  toolName: string
  registeredName: string
}

interface RecentScope {
  ids: Map<string, number>
  updatedAt: number
}

const recentScopes = new Map<string, RecentScope>()
const activeScopes = new Set<string>()
const MAX_RECENT_SCOPES = 1000
const MAX_RECENT_IDS = 50
const DEFAULT_RECENT_WINDOW_SECONDS = 7200
const DEFAULT_RECENT_WINDOW_MINUTES = DEFAULT_RECENT_WINDOW_SECONDS / 60
const MAX_SEARCH_TAGS = 2
const INTENT_TERMS = [
  "安慰", "抚慰", "心疼", "抱抱", "拍拍", "摸摸头", "摸头", "治愈", "鼓励", "宠溺", "乖巧", "辛苦",
  "疲惫", "疲倦", "累", "困", "加班", "低落", "难过", "委屈", "伤心", "开心", "高兴", "庆祝", "生气",
  "疑惑", "无语", "震惊", "尴尬", "害羞", "卖萌", "可爱", "想念", "晚安", "早安", "吃饭", "饿",
]

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function stringList(value: unknown, limit = 24): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(text).map(item => item.trim()).filter(Boolean))].slice(0, limit)
  if (typeof value === "string") return [...new Set(value.split(/[\n,，、|]+/).map(item => item.trim()).filter(Boolean))].slice(0, limit)
  return []
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  if (!source) return ""
  try { return JSON.parse(source) } catch { return value }
}

function candidateUrl(value: unknown): string {
  const url = text(value).trim()
  if (/^https?:\/\//i.test(url)) return url
  if (/^data:image\//i.test(url) || /^base64:\/\//i.test(url)) return url
  return ""
}

function candidateId(value: unknown, url: string): string {
  const direct = text(value).trim()
  if (direct) return direct.slice(0, 200)
  return createHash("sha256").update(url).digest("hex").slice(0, 24)
}

export function stickerCandidateSource(url: string): { kind: "url" | "base64"; value: string } {
  return /^https?:\/\//i.test(url)
    ? { kind: "url", value: url }
    : { kind: "base64", value: url.replace(/^base64:\/\//i, "") }
}

function candidateFrom(value: unknown): StickerCandidate | null {
  if (typeof value === "string") {
    const url = candidateUrl(value)
    return url ? { id: candidateId("", url), url, description: "", tags: [], score: null, matchScore: 0 } : null
  }
  const source = record(value)
  const nested = record(source.source)
  const url = candidateUrl(
    source.url || source.imageUrl || source.image_url || source.image || source.uri || source.src
      || source.address || nested.url || nested.value,
  )
  if (!url) return null
  const tags = stringList(source.tags || source.labels || source.keywords || source.category, 24)
  const description = text(source.description || source.title || source.name || source.caption || source.text).trim().slice(0, 500)
  const score = finiteNumber(source.score ?? source.relevance ?? source.similarity)
  return {
    id: candidateId(source.id || source.imageId || source.uuid || source.key || source.name, url),
    url,
    description,
    tags,
    score,
    matchScore: 0,
  }
}

function collectCandidateValues(value: unknown, output: unknown[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return
  const parsed = safeJson(value)
  if (parsed !== value) {
    collectCandidateValues(parsed, output, depth + 1)
    return
  }
  if (typeof value === "string") {
    if (candidateUrl(value)) output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidateValues(item, output, depth + 1)
    return
  }
  const item = record(value)
  if (candidateFrom(item)) output.push(item)
  for (const key of ["images", "results", "candidates", "items", "data", "content", "structuredContent"]) {
    if (item[key] !== undefined) collectCandidateValues(item[key], output, depth + 1)
  }
  for (const block of Array.isArray(item.content) ? item.content : []) {
    const content = record(block)
    if (content.text !== undefined) collectCandidateValues(content.text, output, depth + 1)
    if (content.data !== undefined) collectCandidateValues(content.data, output, depth + 1)
    if (content.resource !== undefined) collectCandidateValues(content.resource, output, depth + 1)
  }
}

/** 兼容 MCP structuredContent、文本 JSON 和 content 文本三种常见返回形状。 */
export function extractStickerCandidates(value: unknown, limit = 50): StickerCandidate[] {
  const raw: unknown[] = []
  collectCandidateValues(value, raw)
  const seen = new Set<string>()
  const candidates: StickerCandidate[] = []
  for (const item of raw) {
    const candidate = candidateFrom(item)
    if (!candidate) continue
    const key = `${candidate.id}\n${candidate.url}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
    if (candidates.length >= limit) break
  }
  return candidates
}

function intentTerms(keyword: string, tags: string[]): string[] {
  const source = `${keyword} ${tags.join(" ")}`.toLowerCase()
  const known = INTENT_TERMS.filter(term => source.includes(term.toLowerCase()))
  const cjk = source.match(/[\u3400-\u9fff]{2,4}/g) || []
  const latin = source.match(/[a-z0-9][a-z0-9_-]{1,}/g) || []
  return [...new Set([...known, ...cjk, ...latin].map(item => item.trim()).filter(Boolean))]
}

function remoteScore(candidate: StickerCandidate): number {
  if (candidate.score === null) return 0.5
  return Math.max(0, Math.min(1, candidate.score > 1 ? candidate.score / 100 : candidate.score))
}

/** 先看意图和标签命中，再把图库分数作为辅助，避免远端分数压过语境匹配。 */
export function rankStickerCandidates(candidates: StickerCandidate[], keyword: string, tags: string[] = []): StickerCandidate[] {
  const terms = intentTerms(keyword, tags)
  const requiredTags = tags.map(item => item.toLowerCase()).filter(Boolean)
  return candidates
    .filter(candidate => requiredTags.length === 0 || requiredTags.every(tag => candidate.tags.some(item => item.toLowerCase().includes(tag))))
    .map(candidate => {
      const searchable = `${candidate.description} ${candidate.tags.join(" ")}`.toLowerCase()
      const hits = terms.reduce((count, term) => count + (searchable.includes(term.toLowerCase()) ? 1 : 0), 0)
      const exactTagHits = requiredTags.reduce((count, tag) => count + (candidate.tags.some(item => item.toLowerCase().includes(tag)) ? 1 : 0), 0)
      const lexical = terms.length ? hits / terms.length : 0
      const tagMatch = requiredTags.length ? exactTagHits / requiredTags.length : 0
      return { ...candidate, matchScore: lexical * 0.68 + tagMatch * 0.17 + remoteScore(candidate) * 0.15 }
    })
    .sort((left, right) => right.matchScore - left.matchScore || (remoteScore(right) - remoteScore(left)) || left.id.localeCompare(right.id))
}

export function chooseStickerCandidate(candidates: StickerCandidate[], mode: string): StickerCandidate | null {
  if (!candidates.length) return null
  if (mode !== "randomTop") return candidates[0]
  const best = candidates[0].matchScore
  const threshold = best > 0 ? best * 0.88 : 0
  const top = candidates.filter(candidate => candidate.matchScore >= threshold).slice(0, 4)
  return top[Math.floor(Math.random() * top.length)] || candidates[0]
}

export interface StickerExpressionChannelInfo {
  name: string
  displayNameZh: string
  source: string
  serverName: string
  eligible: boolean
  compatibility: "declared" | "inferred" | "incompatible"
  reason: string
}

function schemaPropertyType(value: unknown): string {
  const schema = record(value)
  return text(schema.type)
}

/**
 * 检查一个已注册工具是否能作为日常定格的选图渠道。
 * 渠道只接收 keyword、tags、count，并返回可归一化的 images 候选；不会
 * 在发现阶段调用工具，避免刷新页面就产生网络请求或副作用。
 */
export function inspectStickerExpressionChannel(tool: unknown): StickerExpressionChannelInfo {
  const sourceTool = record(tool)
  const common = getToolCommon(tool)
  const name = text(sourceTool.name).trim()
  const source = text(common.source || sourceTool.source).trim()
  const provenance = record(common.provenance)
  const serverName = text(provenance.serverName || sourceTool.serverName).trim()
  const displayNameZh = text(common.displayNameZh || sourceTool.displayNameZh || name).trim()
  const declaration = record(common.stickerExpressionChannel || sourceTool.stickerExpressionChannel)
  const declared = Number(declaration.version) === 1 && text(declaration.input) === "keyword-tags-count" && text(declaration.output) === "images"
  const parameters = record(common.parameters || sourceTool.parameters)
  const properties = record(parameters.properties)
  const keywordType = schemaPropertyType(properties.keyword)
  const tagsType = schemaPropertyType(properties.tags)
  const countType = schemaPropertyType(properties.count)
  const required = Array.isArray(parameters.required) ? parameters.required.map(text) : []
  const allowedRequired = new Set(["keyword", "tags", "count", "match", "sort"])
  const inputCompatible = keywordType === "string"
    && (tagsType === "" || tagsType === "array")
    && (countType === "" || countType === "integer" || countType === "number")
    && required.every(key => allowedRequired.has(key))
  const haystack = `${name} ${text(common.description)} ${text(common.descriptionZh)} ${stringList(common.tags).join(" ")}`
  const outputHint = /image|图片|表情|sticker|图库|搜图/i.test(haystack)
  const effect = text(record(common.execution).effect)
  const readOnly = declaration.readOnly === true
    || effect === "read"
    || (source === "mcp" && /search[_-]?images?/i.test(name))
  const eligible = readOnly && (declared || (inputCompatible && outputHint))
  const compatibility = declared ? "declared" : eligible ? "inferred" : "incompatible"
  const reason = !readOnly
      ? "渠道不是只读能力。"
      : !inputCompatible && !declared
        ? "缺少约定的 keyword 入参或 tags/count 类型不兼容。"
        : !outputHint && !declared
          ? "未声明或推断出图片候选出参。"
          : "支持日常定格渠道契约。"
  return { name, displayNameZh, source, serverName, eligible, compatibility, reason }
}

export function listStickerExpressionChannels(tools: unknown[] = []): StickerExpressionChannelInfo[] {
  return tools.map(inspectStickerExpressionChannel).filter(item => item.eligible)
}

function scopeKey(event: UnknownRecord = {}): string {
  const group = text(event.group_id || event.groupId || record(event.group).group_id).trim()
  const sender = record(event.sender)
  const user = text(event.user_id || event.userId || sender.user_id || sender.userId).trim()
  return group ? `group:${group}` : `private:${user || "unknown"}`
}

function rememberRecent(scope: string, id: string, windowMs: number): void {
  const now = Date.now()
  let entry = recentScopes.get(scope)
  if (!entry) {
    entry = { ids: new Map(), updatedAt: now }
    recentScopes.set(scope, entry)
  }
  const expiry = now - Math.max(1000, windowMs)
  for (const [key, timestamp] of entry.ids) if (timestamp < expiry) entry.ids.delete(key)
  entry.ids.set(id, now)
  while (entry.ids.size > MAX_RECENT_IDS) {
    const oldest = entry.ids.keys().next().value
    if (typeof oldest !== "string") break
    entry.ids.delete(oldest)
  }
  entry.updatedAt = now
  while (recentScopes.size > MAX_RECENT_SCOPES) {
    const oldest = [...recentScopes.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0]?.[0]
    if (!oldest) break
    recentScopes.delete(oldest)
  }
}

function recentIds(scope: string, windowMs: number): Set<string> {
  const entry = recentScopes.get(scope)
  if (!entry) return new Set()
  const expiry = Date.now() - Math.max(1000, windowMs)
  for (const [key, timestamp] of entry.ids) if (timestamp < expiry) entry.ids.delete(key)
  return new Set(entry.ids.keys())
}

export function resetStickerExpressionState(): void {
  recentScopes.clear()
  activeScopes.clear()
}

/** 在真实消息投递成功后记录选中的图片；选图本身不会占用去重窗口。 */
export function recordStickerExpressionSent(scope: string, bindingKey: string, id: string, windowMinutes = DEFAULT_RECENT_WINDOW_MINUTES): void {
  const normalizedScope = text(scope).trim()
  const normalizedId = text(id).trim()
  if (!normalizedScope || !normalizedId) return
  rememberRecent(normalizedScope, `${text(bindingKey).trim()}:${normalizedId}`, Math.max(1, windowMinutes) * 60_000)
}

/** 秒制配置对应的成功记录入口；保留上面的分钟制导出供旧调用方兼容。 */
export function recordStickerExpressionSentSeconds(scope: string, bindingKey: string, id: string, windowSeconds = DEFAULT_RECENT_WINDOW_SECONDS): void {
  const normalizedScope = text(scope).trim()
  const normalizedId = text(id).trim()
  if (!normalizedScope || !normalizedId) return
  rememberRecent(normalizedScope, `${text(bindingKey).trim()}:${normalizedId}`, Math.max(1, windowSeconds) * 1000)
}

/** MCP 工具注册名带有 mcp_<server>_ 前缀；运行时判断只读搜图时要看原始工具名。 */
function channelOriginalName(tool: unknown, fallback = ""): string {
  const source = record(tool)
  const mcp = record(source.mcp)
  const common = getToolCommon(tool)
  const provenance = record(common.provenance)
  return text(mcp.originalName || source.originalName || provenance.originalName || fallback).trim()
}

function isSemanticMcpSearch(tool: unknown, fallback = ""): boolean {
  const common = getToolCommon(tool)
  if (text(common.source || record(tool).source) !== "mcp") return false
  return /(?:^|[_-])search[_-]?images?(?:$|[_-])/i.test(channelOriginalName(tool, fallback))
}

function configuredToolNames(toolConfig: UnknownRecord): string[] {
  const primary = text(toolConfig.primaryTool || toolConfig.tool || "mcp_imagTag-mcp_search_images").trim() || "mcp_imagTag-mcp_search_images"
  const fallback = text(toolConfig.fallbackTool).trim()
  return [...new Set([primary, ...(fallback && fallback !== primary ? [fallback] : [])])]
}

export interface StickerSelectionResult {
  status: "selected" | "skipped"
  reason?: string
  scope: string
  binding?: StickerBinding
  selected?: StickerCandidate
  ranked: StickerCandidate[]
  candidateCount: number
  selectionMode: "best" | "randomTop"
  recentWindowMinutes: number
  recentWindowSeconds?: number
  errors?: UnknownRecord[]
}

export interface StickerSelectionOptions {
  trackRecent?: boolean
  excludeIds?: Set<string>
}

/**
 * 只负责调用绑定的 MCP 搜图并选择候选，不投递消息。
 *
 * `trackRecent` 仅为旧的模型可见工具保留；日常定格传 false，统一在
 * message_send 成功回执后调用 recordStickerExpressionSent。
 */
export async function selectStickerExpression(
  args: UnknownRecord = {},
  context: StickerExpressionContext = {},
  options: StickerSelectionOptions = {},
): Promise<StickerSelectionResult> {
  const config = context.config || configStore.get()
  const toolConfig = record(context.toolConfig)
  const keyword = text(args.keyword).trim().slice(0, 500)
  const tags = stringList(args.tags, MAX_SEARCH_TAGS).map(item => item.slice(0, 40))
  const candidateCount = Math.max(3, Math.min(50, Number(toolConfig.candidateCount) || 10))
  const selectionMode = text(toolConfig.selectionMode || "randomTop") === "best" ? "best" : "randomTop"
  const configuredRecentSeconds = Number(toolConfig.recentWindowSeconds)
  const hasSecondsWindow = Number.isFinite(configuredRecentSeconds)
  const recentWindowSeconds = hasSecondsWindow
    ? Math.max(1, Math.min(604800, configuredRecentSeconds))
    : Math.max(1, Math.min(10080, Number(toolConfig.recentWindowMinutes) || DEFAULT_RECENT_WINDOW_MINUTES)) * 60
  const recentWindowMinutes = recentWindowSeconds / 60
  const scope = scopeKey(record(context.e))
  const errors: UnknownRecord[] = []
  const diagnostic = (binding: StickerBinding | undefined, tool: unknown, phase: string, code: string, message: unknown, error?: unknown): void => {
    const sourceTool = record(tool)
    const common = getToolCommon(tool)
    const provenance = record(common.provenance)
    const detail = error === undefined ? {} : errorDetails(error)
    errors.push({
      phase,
      code,
      channel: binding?.registeredName || text(sourceTool.name) || "",
      source: text(common.source || sourceTool.source),
      serverName: text(provenance.serverName || sourceTool.serverName || binding?.serverName),
      toolName: channelOriginalName(tool, binding?.toolName || ""),
      message: redactErrorText(message, 500) || "未知错误",
      ...(Object.keys(detail).length ? { details: detail } : {}),
    })
  }
  const empty = (reason: string, binding?: StickerBinding): StickerSelectionResult => ({
    status: "skipped", reason, scope, ...(binding ? { binding } : {}), ranked: [], candidateCount: 0, selectionMode, recentWindowMinutes, recentWindowSeconds,
    ...(errors.length ? { errors: errors.slice() } : {}),
  })
  if (!keyword) return empty("没有足够的语境来选择表情包。")

  const configuredTools = configuredToolNames(toolConfig)
  const firstConfigured = configuredTools[0] || "mcp_imagTag-mcp_search_images"
  const firstBinding = {
    serverName: `tool:${firstConfigured}`,
    toolName: firstConfigured,
    registeredName: firstConfigured,
  }
  if (activeScopes.has(scope)) return empty("当前会话已有一项表情包表达正在处理，已跳过重复调用。", firstBinding || undefined)
  const recent = recentIds(scope, recentWindowSeconds * 1000)
  for (const id of options.excludeIds || []) recent.add(text(id))
  activeScopes.add(scope)
  try {
    const { toolRegistry } = await import("../support/registry.js")
    await toolRegistry.refreshMcpIfNeeded()
    let last: StickerSelectionResult = empty("绑定的选图渠道均未返回符合语境的表情包。", firstBinding || undefined)
    for (const configuredTool of configuredTools) {
      const binding = {
        serverName: `tool:${configuredTool}`,
        toolName: configuredTool,
        registeredName: configuredTool,
      }
      const boundTool = toolRegistry.get(binding.registeredName)
      if (!boundTool) {
        diagnostic(binding, null, "resolve", "TOOL_NOT_FOUND", "绑定的选图工具尚未连接或未开放。")
        last = empty("绑定的选图工具尚未连接或未开放，已尝试下一个渠道。", binding)
        continue
      }
      const effect = text(record(getToolCommon(boundTool).execution).effect)
      const knownReadOnlySearch = isSemanticMcpSearch(boundTool, binding.toolName)
      const declaredReadOnly = record(getToolCommon(boundTool).stickerExpressionChannel).readOnly === true
      const effectUnknown = !effect || effect === "unknown"
      if (effect !== "read" && !(effectUnknown && (knownReadOnlySearch || declaredReadOnly))) {
        diagnostic(binding, boundTool, "contract", "CHANNEL_NOT_READ_ONLY", "绑定的选图工具没有声明为只读搜图能力。")
        last = empty("绑定的选图工具不是只读搜图能力，已尝试下一个渠道。", binding)
        continue
      }
      const queries = tags.length ? [tags, []] : [tags]
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
        const queryTags = queries[queryIndex]
        const searchArgs = buildStickerChannelArguments(boundTool, { keyword, tags: queryTags, count: candidateCount }, toolConfig)
        try {
          const result = await toolRegistry.execute(binding.registeredName, searchArgs, {
            ...context,
            config,
            execution: { ...context.execution, background: false },
          })
          const raw = record(result)
          if (raw.isError === true || ["error", "failed"].includes(text(raw.status))) {
            const contentText = Array.isArray(raw.content)
              ? raw.content.map(item => { const value = record(item); return text(value.text || value.message || value.data) }).filter(Boolean).join(" ")
              : ""
            const responseMessage = raw.error || raw.message || contentText || raw.status || (raw.isError === true ? "工具返回 isError=true。" : "工具返回失败状态。")
            diagnostic(binding, boundTool, "response", "TOOL_RESPONSE_ERROR", responseMessage, raw.error || raw)
            last = empty("图库查询失败，已尝试下一个渠道。", binding)
            break
          }
          const candidates = extractStickerCandidates(projectStickerChannelOutput(result, boundTool, toolConfig), candidateCount * 3)
            .filter(candidate => !recent.has(`${binding.serverName}:${candidate.id}`) && !recent.has(candidate.id))
          const ranked = rankStickerCandidates(candidates, keyword, queryTags)
          const selected = chooseStickerCandidate(ranked, selectionMode)
          if (selected) {
            if (options.trackRecent === true) {
              if (hasSecondsWindow) recordStickerExpressionSentSeconds(scope, binding.serverName, selected.id, recentWindowSeconds)
              else recordStickerExpressionSent(scope, binding.serverName, selected.id, recentWindowMinutes)
            }
            return {
              status: "selected", scope, binding, selected, ranked, candidateCount: ranked.length, selectionMode, recentWindowMinutes, recentWindowSeconds,
              ...(errors.length ? { errors: errors.slice() } : {}),
            }
          }
          const hasTagFallback = queryTags.length > 0 && queryIndex + 1 < queries.length
          diagnostic(binding, boundTool, "response", hasTagFallback ? "TAG_FILTER_NO_MATCH" : (candidates.length ? "NO_MATCHING_CANDIDATES" : "NO_IMAGE_CANDIDATES"), hasTagFallback
            ? "带标签检索没有符合候选，已记录诊断并去掉标签按关键词重试。"
            : candidates.length
              ? "渠道返回候选，但没有符合语境或去重条件的图片。"
              : "渠道没有返回可归一化的图片候选。", { returnedCandidates: candidates.length, requiredTags: queryTags })
          last = { ...empty("图库没有返回符合语境且未重复的表情包，已尝试下一个渠道。", binding), ranked }
        } catch (error) {
          diagnostic(binding, boundTool, "invoke", "TOOL_EXECUTION_ERROR", errorSummary(error, 500), error)
          last = empty("表情包图库暂时不可用，已尝试下一个渠道。", binding)
          break
        }
      }
    }
    return last
  } catch (error) {
    diagnostic(firstBinding || undefined, null, "runtime", "STICKER_SELECTION_ERROR", errorSummary(error, 500), error)
    hostRuntime.logger?.debug?.("[yui-chat] 表情包图库调用失败，已降级为跳过本次表达。", errorSummary(error, 500))
    return empty("表情包图库暂时不可用，已跳过本次表达。", firstBinding || undefined)
  } finally {
    activeScopes.delete(scope)
  }
}

export interface StickerPoolQuery {
  /** 按优先级排列的精确标签；每个标签单独查询一次，结果合并。 */
  tags: string[]
  /** 标签候选不足 topK 时，用该词按描述做一次模糊检索补齐；留空则不补。 */
  fallbackKeyword?: string
}

/** 候选池的一次检索；fallback 标记只用于诊断，候选不足 limit 时照常执行。 */
export interface StickerPoolSearch {
  keyword?: string
  tags?: string[]
  match?: string
  sort?: string
  page?: number
  fallback?: boolean
}

export interface StickerPoolResult {
  status: "ok" | "skipped"
  reason?: string
  scope: string
  binding?: StickerBinding
  pool: StickerCandidate[]
  /** 渠道报告的总数；仅部分图库返回。 */
  total: number | null
  recentWindowSeconds: number
  errors: UnknownRecord[]
}

export interface StickerPoolOptions {
  excludeIds?: Iterable<string>
  /** 候选达到该数量后不再执行后续查询。 */
  limit?: number
  /** 按会话去重并加锁；图库扫描等管理操作传 false。 */
  scoped?: boolean
}

function responseFailure(raw: UnknownRecord): unknown {
  if (raw.isError !== true && !["error", "failed"].includes(text(raw.status))) return null
  const contentText = Array.isArray(raw.content)
    ? raw.content.map(item => { const value = record(item); return text(value.text || value.message || value.data) }).filter(Boolean).join(" ")
    : ""
  return raw.error || raw.message || contentText || raw.status || (raw.isError === true ? "工具返回 isError=true。" : "工具返回失败状态。")
}

function reportedTotal(result: unknown): number | null {
  const source = record(result)
  const structured = record(source.structuredContent)
  const total = Number(structured.total ?? source.total)
  return Number.isFinite(total) && total >= 0 ? total : null
}

/**
 * 按顺序执行一组检索，合并为去重后的候选池。
 *
 * 只调用绑定的只读图库，不投递消息，也不记录去重；主渠道失败或
 * 没有候选时依次尝试回退渠道，沿用原有的诊断格式。
 */
export async function searchStickerPool(
  searches: StickerPoolSearch[],
  context: StickerExpressionContext = {},
  options: StickerPoolOptions = {},
): Promise<StickerPoolResult> {
  const config = context.config || configStore.get()
  const toolConfig = record(context.toolConfig)
  const candidateCount = Math.max(3, Math.min(50, Number(toolConfig.candidateCount) || 30))
  const limit = Math.max(1, Number(options.limit) || candidateCount)
  const configuredRecentSeconds = Number(toolConfig.recentWindowSeconds)
  const recentWindowSeconds = Number.isFinite(configuredRecentSeconds) ? Math.max(1, Math.min(604800, configuredRecentSeconds)) : DEFAULT_RECENT_WINDOW_SECONDS
  const scoped = options.scoped !== false
  const scope = scopeKey(record(context.e))
  const errors: UnknownRecord[] = []
  const skipped = (reason: string, binding?: StickerBinding): StickerPoolResult => ({
    status: "skipped", reason, scope, ...(binding ? { binding } : {}), pool: [], total: null, recentWindowSeconds, errors: errors.slice(),
  })
  if (!searches.length) return skipped("没有可检索的条件。")
  if (scoped && activeScopes.has(scope)) return skipped("当前会话已有一项表情包表达正在处理，已跳过重复调用。")
  const recent = scoped ? recentIds(scope, recentWindowSeconds * 1000) : new Set<string>()
  for (const id of options.excludeIds || []) recent.add(text(id))
  if (scoped) activeScopes.add(scope)
  try {
    const { toolRegistry } = await import("../support/registry.js")
    await toolRegistry.refreshMcpIfNeeded()
    let last = skipped("绑定的选图渠道均未返回可用图片。")
    for (const configuredTool of configuredToolNames(toolConfig)) {
      const binding = { serverName: `tool:${configuredTool}`, toolName: configuredTool, registeredName: configuredTool }
      const boundTool = toolRegistry.get(configuredTool)
      const note = (tool: unknown, phase: string, code: string, message: unknown, detail?: unknown): void => {
        errors.push({ phase, code, channel: configuredTool, toolName: channelOriginalName(tool, configuredTool), message: redactErrorText(message, 500) || "未知错误", ...(detail === undefined ? {} : { details: errorDetails(detail) }) })
      }
      if (!boundTool) {
        note(null, "resolve", "TOOL_NOT_FOUND", "绑定的选图工具尚未连接或未开放。")
        last = skipped("绑定的选图工具尚未连接或未开放，已尝试下一个渠道。", binding)
        continue
      }
      const effect = text(record(getToolCommon(boundTool).execution).effect)
      const declaredReadOnly = record(getToolCommon(boundTool).stickerExpressionChannel).readOnly === true
      if (effect !== "read" && !((!effect || effect === "unknown") && (isSemanticMcpSearch(boundTool, configuredTool) || declaredReadOnly))) {
        note(boundTool, "contract", "CHANNEL_NOT_READ_ONLY", "绑定的选图工具没有声明为只读搜图能力。")
        last = skipped("绑定的选图工具不是只读搜图能力，已尝试下一个渠道。", binding)
        continue
      }
      const pool: StickerCandidate[] = []
      const seen = new Set<string>()
      let total: number | null = null
      let failed = false
      for (const search of searches) {
        // 候选凑够 limit 就停；兜底查询只在前面的查询不够时补齐。
        if (pool.length >= limit) break
        const searchArgs = buildStickerChannelArguments(boundTool, {
          keyword: text(search.keyword),
          tags: search.tags || [],
          count: candidateCount,
          ...(search.sort ? { sort: search.sort } : {}),
          ...(search.match ? { match: search.match } : {}),
          ...(search.page ? { page: search.page } : {}),
        }, toolConfig)
        try {
          const result = await toolRegistry.execute(configuredTool, searchArgs, { ...context, config, execution: { ...context.execution, background: false } })
          const failure = responseFailure(record(result))
          if (failure) {
            note(boundTool, "response", "TOOL_RESPONSE_ERROR", failure)
            failed = true
            break
          }
          total ??= reportedTotal(result)
          for (const candidate of extractStickerCandidates(projectStickerChannelOutput(result, boundTool, toolConfig), candidateCount)) {
            if (recent.has(`${binding.serverName}:${candidate.id}`) || recent.has(candidate.id) || seen.has(candidate.id)) continue
            seen.add(candidate.id)
            pool.push(candidate)
          }
        } catch (error) {
          note(boundTool, "invoke", "TOOL_EXECUTION_ERROR", errorSummary(error, 500), error)
          failed = true
          break
        }
      }
      if (pool.length) return { status: "ok", scope, binding, pool, total, recentWindowSeconds, errors: errors.slice() }
      if (!failed) note(boundTool, "response", "NO_IMAGE_CANDIDATES", "检索条件都没有找到未发送过的图片。", { searches: searches.map(item => ({ keyword: item.keyword, tags: item.tags })) })
      last = skipped(failed ? "表情包图库暂时不可用，已尝试下一个渠道。" : "图库没有符合条件且未重复的图片，已尝试下一个渠道。", binding)
    }
    return last
  } catch (error) {
    errors.push({ phase: "runtime", code: "STICKER_SELECTION_ERROR", message: errorSummary(error, 500) })
    return skipped("表情包图库暂时不可用，已跳过本次表达。")
  } finally {
    if (scoped) activeScopes.delete(scope)
  }
}

/** 把候选池转换为选图结果；selected 为空时视为跳过。 */
export function stickerPoolSelection(result: StickerPoolResult, selected: StickerCandidate | null, reason = ""): StickerSelectionResult {
  const base = {
    scope: result.scope,
    ranked: result.pool,
    candidateCount: result.pool.length,
    selectionMode: "randomTop" as const,
    recentWindowMinutes: result.recentWindowSeconds / 60,
    recentWindowSeconds: result.recentWindowSeconds,
    ...(result.binding ? { binding: result.binding } : {}),
    ...(result.errors.length ? { errors: result.errors } : {}),
  }
  return selected
    ? { status: "selected", selected, ...base }
    : { status: "skipped", reason: reason || result.reason || "没有可用图片。", ...base }
}

/**
 * 按标签组成候选池并随机选图，供日常定格使用。
 *
 * 每个标签按最新排序单独查询，靠前标签的图片排在前面；候选达到
 * topK 后停止继续查询，不足时按分组名模糊检索描述补齐，最后在前
 * topK 张中随机选一张，避免冷门标签总发同一张。
 */
export async function selectStickerByTags(
  query: StickerPoolQuery,
  context: StickerExpressionContext = {},
  options: StickerSelectionOptions & { random?: () => number } = {},
): Promise<StickerSelectionResult> {
  const toolConfig = record(context.toolConfig)
  const tags = stringList(query.tags, 6).map(item => item.slice(0, 40))
  const fallbackKeyword = text(query.fallbackKeyword).trim().slice(0, 100)
  const candidateCount = Math.max(3, Math.min(50, Number(toolConfig.candidateCount) || 30))
  const topK = Math.max(1, Math.min(candidateCount, Number(toolConfig.topK) || 8))
  const searches: StickerPoolSearch[] = tags.map(tag => ({ tags: [tag], sort: "latest" }))
  if (fallbackKeyword) searches.push({ keyword: fallbackKeyword, match: "fuzzy", sort: "latest", fallback: true })
  if (!searches.length) return stickerPoolSelection({ status: "skipped", scope: scopeKey(record(context.e)), pool: [], total: null, recentWindowSeconds: DEFAULT_RECENT_WINDOW_SECONDS, errors: [] }, null, "没有可检索的标签。")
  const result = await searchStickerPool(searches, context, { excludeIds: options.excludeIds, limit: topK })
  if (result.status !== "ok") return stickerPoolSelection(result, null)
  const top = result.pool.slice(0, topK)
  const random = options.random || Math.random
  return stickerPoolSelection(result, top[Math.min(top.length - 1, Math.floor(random() * top.length))])
}

/** 按原文语义召回候选，供精选模式交给决策模型挑图。 */
export async function searchStickersBySemantic(
  keyword: string,
  context: StickerExpressionContext = {},
  options: StickerSelectionOptions & { count?: number } = {},
): Promise<StickerPoolResult> {
  const count = Math.max(3, Math.min(50, Number(options.count) || 20))
  return searchStickerPool([{ keyword: text(keyword).trim().slice(0, 300), match: "semantic", sort: "relevance" }], {
    ...context,
    toolConfig: { ...record(context.toolConfig), candidateCount: count },
  }, { excludeIds: options.excludeIds, limit: count })
}

/** 按最新排序分页读取图库，用于管理台统计；不加会话锁，也不排除已发送图片。 */
export async function scanStickerGallery(
  context: StickerExpressionContext = {},
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<StickerPoolResult> {
  const maxPages = Math.max(1, Math.min(60, Number(options.maxPages) || 40))
  const pageSize = Math.max(3, Math.min(50, Number(options.pageSize) || 50))
  const searches: StickerPoolSearch[] = Array.from({ length: maxPages }, (_, index) => ({ sort: "latest", page: index + 1 }))
  const scanContext = { ...context, toolConfig: { ...record(context.toolConfig), candidateCount: pageSize } }
  const pool: StickerCandidate[] = []
  let first: StickerPoolResult | null = null
  // 逐页请求，拿到总数后提前结束；每页单独调用以便遇到空页时停止。
  for (const search of searches) {
    const page = await searchStickerPool([search], scanContext, { scoped: false })
    first ??= page
    if (page.status !== "ok") break
    const known = new Set(pool.map(item => item.id))
    pool.push(...page.pool.filter(item => !known.has(item.id)))
    if (page.pool.length < pageSize || (page.total !== null && pool.length >= page.total)) break
  }
  if (!first) return { status: "skipped", reason: "没有可扫描的页。", scope: "", pool: [], total: null, recentWindowSeconds: DEFAULT_RECENT_WINDOW_SECONDS, errors: [] }
  return pool.length ? { ...first, status: "ok", pool, total: first.total ?? pool.length } : first
}

/**
 * 取最近上传且本会话没发过的一张图，不做任何语义判断。
 * 最多向后翻三页；三页内都发过时跳过，避免反复翻页。
 */
export async function selectLatestSticker(
  context: StickerExpressionContext = {},
  options: StickerSelectionOptions = {},
): Promise<StickerSelectionResult> {
  const searches: StickerPoolSearch[] = [1, 2, 3].map(page => ({ sort: "latest", page }))
  const result = await searchStickerPool(searches, context, { excludeIds: options.excludeIds, limit: 1 })
  return stickerPoolSelection(result, result.status === "ok" ? result.pool[0] : null)
}
