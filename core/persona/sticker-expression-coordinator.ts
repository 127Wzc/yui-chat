import path from "node:path"
import { configStore, dataDir } from "../../config/store.js"
import { runIsolatedModelTask } from "../../models/isolated-task.js"
import { recentContextStore } from "../chat/recent-context.js"
import { normalizeEventScope, groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { AtomicJsonRepository } from "../storage/atomic-json-repository.js"
import { executeDirectTool } from "../../tools/support/direct-execution.js"
import {
  recordStickerExpressionSentSeconds,
  selectStickerExpression,
  stickerCandidateSource,
  type StickerCandidate,
} from "../../tools/builtins/sticker-expression.js"
import type { RuntimeConfigObject } from "../../config/types.js"

type UnknownRecord = Record<string, unknown>

interface PersistedRecent {
  binding: string
  id: string
  at: number
}

interface PersistedScope {
  date: string
  sentCount: number
  lastAttemptAt: number
  lastSuccessAt: number
  recent: PersistedRecent[]
}

interface PersistedState {
  scopes: Record<string, PersistedScope>
}

interface PendingWindow {
  version: number
  timer: ReturnType<typeof setTimeout>
  event: UnknownRecord
}

interface AttemptOptions {
  config?: RuntimeConfigObject | UnknownRecord
  event: UnknownRecord
  mode: "conversation" | "ambient" | "idle"
  contextText?: string
  prompt?: string
  tags?: string[]
  force?: boolean
  dryRun?: boolean
  version?: number
}

export interface StickerExpressionGateState {
  lastSuccessAt?: number
  lastAttemptAt?: number
  sentCount?: number
}

const stateRepository = new AtomicJsonRepository<PersistedState>({
  file: path.join(dataDir, "daily-still-state.json"),
  defaultValue: { scopes: {} },
  normalize(value) {
    const scopes: Record<string, PersistedScope> = {}
    for (const [key, raw] of Object.entries(value?.scopes || {})) {
      const item = record(raw)
      scopes[key] = {
        date: text(item.date),
        sentCount: Math.max(0, number(item.sentCount, 0)),
        lastAttemptAt: Math.max(0, number(item.lastAttemptAt, 0)),
        lastSuccessAt: Math.max(0, number(item.lastSuccessAt, 0)),
        recent: Array.isArray(item.recent)
          ? item.recent.map(record).map(entry => ({ binding: text(entry.binding), id: text(entry.id), at: number(entry.at, 0) })).filter(entry => entry.binding && entry.id && entry.at > 0).slice(-50)
          : [],
      }
    }
    return { scopes }
  },
})

let state: PersistedState = { scopes: {} }
let stateLoaded = false
const pendingWindows = new Map<string, PendingWindow>()
const versions = new Map<string, number>()
const moods = new Map<string, { emotion: string; intensity: number; at: number; expiresAt: number }>()

const runningScopes = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
let startedAt = 0
let nextRunAt = 0
let lastAttemptAt = 0
let lastSuccessAt = 0
let lastError = ""
let attempts = 0
let skipped = 0
let sent = 0

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback: number): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

/** 读取日常定格时长；新配置统一用秒，旧字段只作为升级兼容回退。 */
function durationSeconds(source: UnknownRecord, secondsKey: string, fallbackSeconds: number, legacyMsKey = "", legacyMinutesKey = ""): number {
  const current = Number(source[secondsKey])
  if (Number.isFinite(current)) return Math.max(0, current)
  if (legacyMsKey) {
    const legacyMs = Number(source[legacyMsKey])
    if (Number.isFinite(legacyMs)) return Math.max(0, legacyMs / 1000)
  }
  if (legacyMinutesKey) {
    const legacyMinutes = Number(source[legacyMinutesKey])
    if (Number.isFinite(legacyMinutes)) return Math.max(0, legacyMinutes * 60)
  }
  return fallbackSeconds
}

function durationMs(source: UnknownRecord, secondsKey: string, fallbackSeconds: number, legacyMsKey = "", legacyMinutesKey = ""): number {
  return durationSeconds(source, secondsKey, fallbackSeconds, legacyMsKey, legacyMinutesKey) * 1000
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map(text).map(item => item.trim()).filter(Boolean))]
  return text(value).split(/[\n,，、|]+/).map(item => item.trim()).filter(Boolean)
}

function configOf(config: unknown = {}): UnknownRecord {
  return record(record(record(config).persona).stickerExpression)
}

function scopeKey(event: UnknownRecord): string {
  const groupId = groupIdFromEvent(event)
  if (isGroupEvent(event) && groupId) return `group:${groupId}`
  const sender = record(event.sender)
  return `private:${text(event.user_id || event.userId || sender.user_id || sender.userId || "unknown")}`
}

function currentDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

function stateFor(scope: string): PersistedScope {
  const date = currentDate()
  const current = state.scopes[scope]
  if (!current || current.date !== date) {
    const next: PersistedScope = { date, sentCount: 0, lastAttemptAt: 0, lastSuccessAt: 0, recent: [] }
    state.scopes[scope] = next
    return next
  }
  const expiry = Date.now() - 14 * 86400000
  current.recent = current.recent.filter(item => item.at >= expiry).slice(-50)
  return current
}

function moodFor(scope: string, now: number): UnknownRecord {
  const mood = moods.get(scope)
  if (!mood || mood.expiresAt <= now) {
    moods.delete(scope)
    return {}
  }
  return mood
}

async function ensureState(): Promise<void> {
  if (stateLoaded) return
  state = await stateRepository.load()
  stateLoaded = true
}

async function persistState(): Promise<void> {
  try {
    // Merge through the repository's serialized update queue so a concurrent
    // scope cannot overwrite another scope's newly recorded receipt.
    state = await stateRepository.update(current => ({
      scopes: {
        ...current.scopes,
        ...state.scopes,
      },
    }))
  } catch (error) {
    hostRuntime.logger?.warn?.("[yui-chat] 日常定格状态写入失败，继续使用内存状态", error)
  }
}

function modeConfig(config: unknown, mode: AttemptOptions["mode"]): UnknownRecord {
  return record(configOf(config)[mode])
}

function bindingSignature(config: unknown): string {
  const binding = record(configOf(config).binding)
  return ["primaryTool", "fallbackTool", "tool", "mcpServer", "mcpTool", "candidateCount", "selectionMode", "adapterConfigs"]
    .map(key => `${key}=${key === "adapterConfigs" ? JSON.stringify(binding[key] || {}) : text(binding[key]).trim()}`)
    .join("|")
}

function boundedContext(event: UnknownRecord, maxMessages: number, ttlMs = 0): string {
  const latest = recentContextStore.latestMessageAt(event)
  if (ttlMs > 0 && latest > 0 && Date.now() - latest > ttlMs) return ""
  const prompt = recentContextStore.buildPrompt(event)
  if (!prompt) return ""
  const lines = prompt.split("\n")
  const limit = Math.max(1, Math.floor(maxMessages))
  return [lines[0], ...lines.slice(-limit)].join("\n")
}

/** 黑名单优先；群聊没有白名单时永远不触发，避免新群被动收到图片。 */
export function isStickerExpressionScopeAllowed(event: unknown, config: unknown = {}): boolean {
  const e = record(event)
  const cfg = configOf(config)
  if (cfg.enabled === false) return false
  if (!isGroupEvent(e)) return cfg.privateEnabled === true
  const groupId = groupIdFromEvent(e)
  if (!groupId) return false
  const scope = record(cfg.groupScope)
  const blocklist = list(scope.blocklist)
  if (blocklist.includes(groupId)) return false
  const allowlist = list(scope.allowlist)
  return allowlist.includes(groupId)
}

export function stickerExpressionProbabilityHit(percent: unknown, random = Math.random()): boolean {
  const value = Math.max(0, Math.min(100, number(percent, 0)))
  return value >= 100 || (value > 0 && random * 100 < value)
}

/** 用户明确点图时交给正常模型工具链，自动表达入口只旁观跳过。 */
export function stickerExpressionExplicitRequest(value: unknown): boolean {
  const input = text(value).replace(/\s+/g, "").trim()
  if (!input) return false
  if (/(?:不要|别|无需|不用|不想|禁止)(?:再)?(?:发|来|给|配|附)?(?:个|张|一张)?(?:表情包|表情|图片|图|自拍)/u.test(input)) return false
  return /(?:发|来|给|要|想要|想看|丢|贴|整|发送|配|附).{0,8}(?:表情包|表情|图片|图|自拍)|(?:表情包|表情|图片|图|自拍)(?:呢|呀|吧)?[！？!！?？]?(?:发|来|给|要|丢|贴|整)/u.test(input)
}

export function stickerExpressionGate(config: unknown, current: StickerExpressionGateState = {}, now = Date.now()): string {
  const cfg = configOf(config)
  const cooldownMs = durationMs(cfg, "cooldownSeconds", 1800, "cooldownMs")
  const attemptIntervalMs = durationMs(cfg, "attemptIntervalSeconds", 300, "attemptIntervalMs")
  const quota = Math.max(0, Math.floor(number(cfg.dailyQuota, 0)))
  if (cooldownMs > 0 && now - number(current.lastSuccessAt, 0) < cooldownMs) return "cooldown"
  if (attemptIntervalMs > 0 && now - number(current.lastAttemptAt, 0) < attemptIntervalMs) return "attempt-interval"
  if (quota > 0 && number(current.sentCount, 0) >= quota) return "daily-quota"
  return "ok"
}

export function stickerExpressionReceiptStatus(value: unknown): "sent" | "partial" | "failed" | "ambiguous" {
  const result = record(value)
  if (result.status === "ambiguous" || result.status === "canceled") return "ambiguous"
  const output = record(result.value)
  const receipt = record(output.receipt)
  const structured = record(output.structuredContent)
  const status = text(receipt.status || structured.status)
  if (status === "sent" && number(receipt.sentCount || structured.sentCount, 0) > 0) return "sent"
  if (status === "partial" && number(receipt.sentCount || structured.sentCount, 0) > 0) return "partial"
  return "failed"
}

function allowedHours(cfg: UnknownRecord, now = new Date()): boolean {
  const hours = record(record(cfg.idle).allowedHours)
  const start = text(hours.start || "00:00")
  const end = text(hours.end || "23:59")
  const current = now.getHours() * 60 + now.getMinutes()
  const parse = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value)
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0
  }
  const from = parse(start)
  const to = parse(end)
  return from <= to ? current >= from && current <= to : current >= from || current <= to
}

function extractJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  try { return JSON.parse(source) } catch {
    const start = source.indexOf("{")
    const end = source.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try { return JSON.parse(source.slice(start, end + 1)) } catch { return null }
    }
    return null
  }
}

export interface StickerIntent {
  shouldSend: boolean
  emotion: string
  intensity: number
  keyword: string
  tags: string[]
}

export function parseStickerIntent(value: unknown): StickerIntent | null {
  const item = record(extractJson(value))
  const keyword = text(item.keyword).trim().slice(0, 500)
  const tags = list(item.tags).slice(0, 12).map(tag => tag.slice(0, 40))
  if (typeof item.shouldSend !== "boolean") return null
  if (item.shouldSend && keyword.length < 2) return null
  return {
    shouldSend: item.shouldSend,
    emotion: text(item.emotion || "平静").trim().slice(0, 40),
    intensity: Math.max(0, Math.min(1, number(item.intensity, 0.5))),
    keyword,
    tags,
  }
}

function intentPrompt(mode: AttemptOptions["mode"], contextText: string, prompt: string, mood: UnknownRecord): string {
  return [
    `你是“日常定格”的表达意图判断器，触发来源为 ${mode}。`,
    "只判断是否值得发送一张表情包，不要回答用户，不要调用工具。",
    "返回严格 JSON，不要 Markdown：{\"shouldSend\":true|false,\"emotion\":\"...\",\"intensity\":0到1,\"keyword\":\"态度和画面描述\",\"tags\":[\"确认存在的标签\"]}。",
    "只有语境明确、表情包能补充交流时 shouldSend 才为 true；不合适、重复、需要文字解释或会打断正在进行的对话时为 false。",
    mood.emotion ? `最近心情参考：${text(mood.emotion)}（强度 ${number(mood.intensity, 0.5).toFixed(2)}）` : "最近没有可用的短期心情。",
    `当前消息或回复：${prompt.slice(0, 2000) || "（无）"}`,
    `最近窗口：${contextText.slice(0, 5000) || "（无）"}`,
  ].join("\n")
}

function ownEvent(event: UnknownRecord): boolean {
  const sender = record(event.sender)
  const selfId = text(event.self_id || record(event.bot).uin || record(hostRuntime.bot).uin).trim()
  const userId = text(event.user_id || sender.user_id || sender.userId).trim()
  return Boolean(selfId && userId && selfId === userId)
}

async function syntheticGroupEvent(groupId: string, source: UnknownRecord = {}): Promise<UnknownRecord> {
  const bot = source.bot || hostRuntime.bot
  return normalizeEventScope({
    isGroup: true,
    isPrivate: false,
    message_type: "group",
    group_id: groupId,
    user_id: "system",
    self_id: text(record(bot).uin),
    sender: { user_id: "system", nickname: "Yui Chat" },
    bot,
    msg: "",
    raw_message: "",
    async reply(payload: unknown, _quote?: unknown): Promise<unknown> {
      const picker = record(bot).pickGroup
      if (typeof picker !== "function") throw new Error("宿主不支持按群号发送消息。")
      const group = record(await (picker as (...args: unknown[]) => Promise<unknown>).call(bot, Number(groupId), true))
      const send = group.sendMsg
      if (typeof send !== "function") throw new Error(`无法获取群 ${groupId}，请确认机器人仍在群内。`)
      return (send as (value: unknown) => Promise<unknown>).call(group, payload)
    },
  })
}

function stale(scope: string, version?: number): boolean {
  return !stickerExpressionVersionCurrent(versions.get(scope), version)
}

export function stickerExpressionVersionCurrent(current: number | undefined, expected: number | undefined): boolean {
  return expected === undefined || current === expected
}

function clearPending(scope: string): void {
  const pending = pendingWindows.get(scope)
  if (pending) clearTimeout(pending.timer)
  pendingWindows.delete(scope)
  versions.set(scope, (versions.get(scope) || 0) + 1)
}

function receiptSuccessful(value: unknown): boolean {
  const result = record(value)
  return result.status === "success" && stickerExpressionReceiptStatus(value) === "sent"
}

async function sendCandidate(event: UnknownRecord, candidate: StickerCandidate, context: UnknownRecord): Promise<UnknownRecord> {
  const result = await executeDirectTool("message_send", {
    parts: [{ type: "image", source: stickerCandidateSource(candidate.url) }],
  }, {
    e: event,
    config: context.config as RuntimeConfigObject,
    source: "dailyStill",
    agent: { signal: context.signal as AbortSignal | undefined },
    execution: { background: false },
    observability: { trace: { id: `daily-still-${Date.now()}` } },
  })
  return record(result)
}

async function attempt(options: AttemptOptions): Promise<UnknownRecord> {
  const config = options.config || await configStore.load()
  const cfg = configOf(config)
  const event = normalizeEventScope(options.event)
  const scope = scopeKey(event)
  const mode = modeConfig(config, options.mode)
  if (cfg.enabled === false || mode.enabled !== true || !isStickerExpressionScopeAllowed(event, config)) return { skipped: true, reason: "disabled-or-scope" }
  if (options.mode === "idle" && !allowedHours(cfg)) return { skipped: true, reason: "outside-hours" }
  if (stale(scope, options.version)) return { skipped: true, reason: "canceled" }
  if (runningScopes.has(scope)) return { skipped: true, reason: "running" }
  await ensureState()
  const scopeState = stateFor(scope)
  const now = Date.now()
    const lastAttempt = scopeState.lastAttemptAt
  if (!options.force) {
    const gate = stickerExpressionGate(config, { lastSuccessAt: scopeState.lastSuccessAt, lastAttemptAt: lastAttempt, sentCount: scopeState.sentCount }, now)
    if (gate !== "ok") return { skipped: true, reason: gate }
  }
  if (!options.force && !stickerExpressionProbabilityHit(mode.probabilityPercent)) return { skipped: true, reason: "probability" }

  runningScopes.add(scope)
  attempts++
  if (options.dryRun !== true) {
    scopeState.lastAttemptAt = now
    // 失败、取消和没有候选也算一次尝试；这样重启后不会立即重复调用模型。
    await persistState()
  }
  lastAttemptAt = now
  try {
    const contextText = options.contextText || boundedContext(event, options.mode === "ambient" ? number(mode.maxMessages, 8) : 12, durationMs(cfg, "contextTtlSeconds", 900, "contextTtlMs"))
    const prompt = options.prompt || text(event.msg || event.raw_message)
    const mood = moodFor(scope, now)
    const intentResult = await runIsolatedModelTask({
      config: config as RuntimeConfigObject,
      taskName: text(cfg.intentTask || "replyer"),
      timeoutMs: durationMs(cfg, "intentTimeoutSeconds", 30, "intentTimeoutMs"),
      maxTokens: 400,
      systemPrompt: intentPrompt(options.mode, contextText, prompt, mood),
      prompt: "请根据以上规则只输出 JSON。",
      event,
      purpose: "chat",
      source: "dailyStill.intent",
      metadata: { mode: options.mode, scope },
    })
    const intent = parseStickerIntent(intentResult.text)
    if (!intent || !intent.shouldSend) return { skipped: true, reason: "intent-negative", intent }
    if (stale(scope, options.version) || (isGroupEvent(event) && event.__yuiChatReplied === true)) return { skipped: true, reason: "canceled-after-intent", intent }
    if (bool(cfg.moodEnabled, true)) {
      moods.set(scope, { emotion: intent.emotion, intensity: intent.intensity, at: now, expiresAt: now + Math.max(1, durationSeconds(cfg, "moodDecaySeconds", 14400, "", "moodDecayMinutes")) * 1000 })
    }
    const bindingConfig = record(cfg.binding)
    const recentIds = new Set(scopeState.recent.map(item => item.id))
    const selection = await selectStickerExpression({ keyword: intent.keyword, tags: intent.tags }, {
      e: event,
      config: config as RuntimeConfigObject,
      toolConfig: {
        ...bindingConfig,
        recentWindowSeconds: durationSeconds(cfg, "recentWindowSeconds", 7200, "", "recentWindowMinutes"),
      },
      signal: options.event.signal as AbortSignal | undefined,
    }, { trackRecent: false, excludeIds: recentIds })
    if (selection.status !== "selected" || !selection.selected || !selection.binding) {
      const diagnostics = Array.isArray(selection.errors) ? selection.errors : []
      if (diagnostics.length) lastError = diagnostics.map(item => text(record(item).message)).filter(Boolean).join("；").slice(0, 500)
      return { skipped: true, reason: selection.reason || "no-candidate", intent, selection }
    }
    if (options.dryRun === true) return { skipped: false, dryRun: true, intent, selection: { ...selection, selected: { ...selection.selected, url: selection.selected.url } } }
    const currentConfig = configStore.get()
    const currentMode = modeConfig(currentConfig, options.mode)
    if (bindingSignature(currentConfig) !== bindingSignature(config)
      || configOf(currentConfig).enabled !== true
      || currentMode.enabled !== true
      || !isStickerExpressionScopeAllowed(event, currentConfig)
      || stale(scope, options.version)) {
      return { skipped: true, reason: "stale-config", intent, selection }
    }
    await ensureState()
    const latestState = stateFor(scope)
    const sendGate = stickerExpressionGate(currentConfig, {
      lastSuccessAt: latestState.lastSuccessAt,
      // 本次机会已经记录过尝试时间；发送前只重新检查成功冷却和配额。
      lastAttemptAt: 0,
      sentCount: latestState.sentCount,
    })
    if (sendGate === "cooldown" || sendGate === "daily-quota") return { skipped: true, reason: `stale-${sendGate}`, intent, selection }
    const delivery = await sendCandidate(event, selection.selected, { config })
    if (!receiptSuccessful(delivery)) {
      lastError = text(record(delivery.value).error || delivery.error || "表情包投递失败")
      return { skipped: true, reason: delivery.status || "delivery-failed", intent, selection, delivery }
    }
    const sentAt = Date.now()
    scopeState.sentCount += 1
    scopeState.lastSuccessAt = sentAt
    scopeState.recent.push({ binding: selection.binding.serverName, id: selection.selected.id, at: sentAt })
    scopeState.recent = scopeState.recent.slice(-50)
    recordStickerExpressionSentSeconds(scope, selection.binding.serverName, selection.selected.id, durationSeconds(cfg, "recentWindowSeconds", 7200, "", "recentWindowMinutes"))
    await persistState()
    lastSuccessAt = sentAt
    sent++
    event.__yuiChatReplied = true
    return { skipped: false, sent: true, intent, selection, delivery }
  } catch (error) {
    lastError = text(error instanceof Error ? error.message : error).slice(0, 300)
    return { skipped: true, reason: "error", error: lastError }
  } finally {
    runningScopes.delete(scope)
  }
}

async function preview(options: { config?: unknown; event: UnknownRecord; keyword: string; tags?: string[]; send?: boolean }): Promise<UnknownRecord> {
  const config = options.config || await configStore.load()
  const cfg = configOf(config)
  const event = normalizeEventScope(options.event)
  const scope = scopeKey(event)
  await ensureState()
  const current = stateFor(scope)
  const selection = await selectStickerExpression({ keyword: options.keyword, tags: options.tags || [] }, {
    e: event,
    config: config as RuntimeConfigObject,
    toolConfig: { ...record(cfg.binding), recentWindowSeconds: durationSeconds(cfg, "recentWindowSeconds", 7200, "", "recentWindowMinutes") },
  }, { trackRecent: false, excludeIds: new Set(current.recent.map(item => item.id)) })
  if (selection.status !== "selected" || !selection.selected) return { ok: false, reason: selection.reason || "没有可用候选", selection }
  if (options.send === true) {
    const delivery = await sendCandidate(event, selection.selected, { config })
    return { ok: receiptSuccessful(delivery), selection, delivery }
  }
  return { ok: true, preview: true, selection: { ...selection, selected: { ...selection.selected } } }
}

class StickerExpressionCoordinator {
  start(config: unknown = {}): UnknownRecord {
    this.stop()
    const cfg = configOf(config)
    const idle = record(cfg.idle)
    if (cfg.enabled === false || idle.enabled !== true || !list(idle.groups).length) return this.stats()
    const intervalMs = Math.max(1, durationSeconds(idle, "intervalSeconds", 1800, "", "intervalMinutes")) * 1000
    startedAt = Date.now()
    nextRunAt = startedAt + intervalMs
    timer = setInterval(() => { void this.runIdle({ reason: "interval" }).catch(error => { lastError = text(error) }) }, intervalMs)
    const value = timer as ReturnType<typeof setInterval> & { unref?: () => void }
    value.unref?.()
    return this.stats()
  }

  stop(): UnknownRecord {
    if (timer) clearInterval(timer)
    timer = null
    nextRunAt = 0
    for (const scope of pendingWindows.keys()) clearPending(scope)
    return this.stats()
  }

  async afterConversation(event: unknown, options: UnknownRecord = {}): Promise<UnknownRecord> {
    const e = record(event)
    if (e.__yuiChatReplied && text(options.source) === "dailyStill") return { skipped: true, reason: "self" }
    if (text(options.source) === "dailyStill" || text(options.source) === "initiativeGreeting" || text(options.source) === "web-test") return { skipped: true, reason: "internal" }
    if (stickerExpressionExplicitRequest(e.msg || e.raw_message || options.prompt)) return { skipped: true, reason: "explicit-request" }
    const result = await attempt({
      config: options.config as RuntimeConfigObject,
      event: e,
      mode: "conversation",
      prompt: `${text(options.prompt || e.msg || e.raw_message)}\n助手回复：${text(options.botText)}`,
      contextText: boundedContext(e, 12, durationMs(configOf(options.config), "contextTtlSeconds", 900, "contextTtlMs")),
    })
    return result
  }

  observeGroupMessage(event: unknown): void {
    const e = normalizeEventScope(record(event))
    if (!isGroupEvent(e)) return
    const scope = scopeKey(e)
    clearPending(scope)
    const cfg = configOf(configStore.get())
    const ambient = record(cfg.ambient)
    if (cfg.enabled === false || ambient.enabled !== true || e.__yuiChatReplied === true || ownEvent(e) || stickerExpressionExplicitRequest(e.msg || e.raw_message) || !isStickerExpressionScopeAllowed(e, configStore.get())) return
    const version = versions.get(scope) || 0
    const windowMs = Math.max(1000, durationMs(ambient, "windowSeconds", 15, "windowMs"))
    const timerValue = setTimeout(() => {
      pendingWindows.delete(scope)
      void attempt({ config: configStore.get(), event: e, mode: "ambient", contextText: boundedContext(e, number(ambient.maxMessages, 8), durationMs(configOf(configStore.get()), "contextTtlSeconds", 900, "contextTtlMs")), prompt: text(e.msg || e.raw_message), version }).catch(error => { lastError = text(error) })
    }, windowMs)
    pendingWindows.set(scope, { version, timer: timerValue, event: e })
  }

  async runIdle(options: UnknownRecord = {}): Promise<UnknownRecord> {
    const config = options.config || await configStore.load()
    const cfg = configOf(config)
    const idle = record(cfg.idle)
    const groups = list(idle.groups)
    const results: UnknownRecord[] = []
    for (const groupId of groups) {
      const event = await syntheticGroupEvent(groupId, record(options))
      if (!isStickerExpressionScopeAllowed(event, config)) { results.push({ groupId, skipped: true, reason: "scope" }); continue }
      const lastMessageAt = recentContextStore.latestMessageAt(event)
      if (!lastMessageAt || Date.now() - lastMessageAt < Math.max(1, durationSeconds(idle, "minIdleSeconds", 1800, "", "minIdleMinutes")) * 1000) {
        results.push({ groupId, skipped: true, reason: "not-idle" }); continue
      }
      const version = versions.get(scopeKey(event)) || 0
      results.push(await attempt({ config: config as RuntimeConfigObject, event, mode: "idle", contextText: boundedContext(event, 12, durationMs(cfg, "contextTtlSeconds", 900, "contextTtlMs")), prompt: "群聊已经安静了一段时间。" , version, force: options.force === true, dryRun: options.dryRun === true }))
    }
    nextRunAt = timer ? Date.now() + Math.max(1, durationSeconds(idle, "intervalSeconds", 1800, "", "intervalMinutes")) * 1000 : 0
    return { groups: groups.length, results }
  }

  async preview(options: { config?: unknown; event: UnknownRecord; keyword: string; tags?: string[]; send?: boolean }): Promise<UnknownRecord> {
    return preview(options)
  }

  async clearState(): Promise<UnknownRecord> {
    await ensureState()
    const count = Object.keys(state.scopes).length
    state = { scopes: {} }
    moods.clear()
    await persistState()
    return { scopes: count }
  }

  stats(): UnknownRecord {
    const cfg = configOf(configStore.get())
    return {
      enabled: cfg.enabled === true,
      active: Boolean(timer),
      runningScopes: runningScopes.size,
      pendingWindows: pendingWindows.size,
      startedAt: startedAt ? new Date(startedAt).toISOString() : "",
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : "",
      lastAttemptAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : "",
      lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : "",
      attempts,
      sent,
      skipped,
      lastError,
    }
  }
}

export const stickerExpressionCoordinator = new StickerExpressionCoordinator()

export function buildStickerExpressionStatus(config: unknown = configStore.get()): UnknownRecord {
  const cfg = configOf(config)
  const binding = record(cfg.binding)
  const primaryTool = text(binding.primaryTool || binding.tool || "mcp_imagTag-mcp_search_images")
  return {
    config: cfg,
    scheduler: stickerExpressionCoordinator.stats(),
    binding: {
      primaryTool,
      fallbackTool: text(binding.fallbackTool),
      // 保留旧字段，便于已有配置和外部诊断读取。
      tool: primaryTool,
      mcpServer: text(binding.mcpServer),
      mcpTool: text(binding.mcpTool || "search_images"),
    },
  }
}

export async function noteExternalStickerDelivery(event: unknown, metadata: unknown): Promise<void> {
  const info = record(metadata)
  const sticker = record(info.stickerExpression)
  const selectedId = text(sticker.selectedId).trim()
  const server = text(sticker.serverName).trim()
  if (!selectedId || !server) return
  const scope = scopeKey(record(event))
  await ensureState()
  const current = stateFor(scope)
  const now = Date.now()
  current.sentCount += 1
  current.lastSuccessAt = now
  current.recent.push({ binding: server, id: selectedId, at: now })
  current.recent = current.recent.slice(-50)
  const cfg = configOf(configStore.get())
  recordStickerExpressionSentSeconds(scope, server, selectedId, durationSeconds(cfg, "recentWindowSeconds", 7200, "", "recentWindowMinutes"))
  lastSuccessAt = now
  sent++
  await persistState()
}
