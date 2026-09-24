import path from "node:path"
import { configStore, dataDir } from "../../config/store.js"
import { recentContextStore } from "../chat/recent-context.js"
import { normalizeEventScope, groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { AtomicJsonRepository } from "../storage/atomic-json-repository.js"
import { executeDirectTool } from "../../tools/support/direct-execution.js"
import {
  recordStickerExpressionSentSeconds,
  scanStickerGallery,
  searchStickersBySemantic,
  selectLatestSticker,
  selectStickerByTags,
  stickerCandidateSource,
  stickerPoolSelection,
  type StickerCandidate,
  type StickerSelectionResult,
} from "../../tools/builtins/sticker-expression.js"
import {
  avoidRepeatedMood,
  dailyStillDecisionAvailable,
  decideDailyStill,
  decideDailyStillImage,
  type DailyStillDecision,
  type DailyStillImageDecision,
} from "./daily-still-decider.js"
import { conversationMoods, dailyStillMoods, parseStillDescription, pickIdleMood, summarizeGallery, type GalleryStats } from "./daily-still-moods.js"
import type { JsonValue } from "../message-chain/types.js"
import type { RuntimeConfigObject } from "../../config/types.js"

type UnknownRecord = Record<string, unknown>

interface PersistedRecent {
  binding: string
  id: string
  at: number
}

interface PersistedMood {
  name: string
  at: number
}

interface PersistedScope {
  date: string
  sentCount: number
  lastAttemptAt: number
  lastAmbientAttemptAt: number
  lastSuccessAt: number
  recent: PersistedRecent[]
  /** 最近发送的情绪分组，用于避免连续发同一种情绪。 */
  moods: PersistedMood[]
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
  /** 对话入口：用户消息与机器人回复。 */
  userText?: string
  replyText?: string
  /** 旁观入口：最近窗口原文。 */
  contextText?: string
  force?: boolean
  dryRun?: boolean
  version?: number
}

/** 决策模型只看截断后的短内容，控制每次判断的 token。 */
const STATE_TEXT_LIMIT = 200
const STATE_LINE_LIMIT = 120
const MAX_RECENT = 80
const MAX_RECENT_MOODS = 20
/** 精选模式至少需要这么多候选才值得让决策模型挑图。 */
const MIN_IMAGE_POOL = 3

export interface StickerExpressionGateState {
  lastSuccessAt?: number
  lastAttemptAt?: number
  lastAmbientAttemptAt?: number
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
        lastAmbientAttemptAt: Math.max(0, number(item.lastAmbientAttemptAt, 0)),
        lastAttemptAt: Math.max(0, number(item.lastAttemptAt, 0)),
        lastSuccessAt: Math.max(0, number(item.lastSuccessAt, 0)),
        recent: Array.isArray(item.recent)
          ? item.recent.map(record).map(entry => ({ binding: text(entry.binding), id: text(entry.id), at: number(entry.at, 0) })).filter(entry => entry.binding && entry.id && entry.at > 0).slice(-MAX_RECENT)
          : [],
        moods: Array.isArray(item.moods)
          ? item.moods.map(record).map(entry => ({ name: text(entry.name), at: number(entry.at, 0) })).filter(entry => entry.name && entry.at > 0).slice(-MAX_RECENT_MOODS)
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

const runningScopes = new Set<string>()
let timer: ReturnType<typeof setInterval> | null = null
let startedAt = 0
let nextRunAt = 0
let lastAttemptAt = 0
let lastSuccessAt = 0
let lastError = ""
let lastOutcome: UnknownRecord | null = null
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
    // 配额和尝试时间按天重置；已发送图片跨天保留，避免每天都从同一批最新图片里重复挑。
    const next: PersistedScope = { date, sentCount: 0, lastAmbientAttemptAt: current?.lastAmbientAttemptAt || 0, lastAttemptAt: current?.lastAttemptAt || 0, lastSuccessAt: current?.lastSuccessAt || 0, recent: current?.recent || [], moods: current?.moods || [] }
    state.scopes[scope] = next
  }
  const active = state.scopes[scope]
  const expiry = Date.now() - 14 * 86400000
  active.recent = active.recent.filter(item => item.at >= expiry).slice(-MAX_RECENT)
  active.moods = (active.moods || []).filter(item => item.at >= expiry).slice(-MAX_RECENT_MOODS)
  return active
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
  return ["primaryTool", "fallbackTool", "tool", "mcpServer", "mcpTool", "candidateCount", "topK", "adapterConfigs"]
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

export function stickerExpressionGate(config: unknown, current: StickerExpressionGateState = {}, now = Date.now(), mode: AttemptOptions["mode"] = "conversation"): string {
  const cfg = configOf(config)
  if (mode === "ambient" && number(current.lastAmbientAttemptAt, 0) > 0
    && now - number(current.lastAmbientAttemptAt, 0) < durationMs(record(cfg.ambient), "intervalSeconds", 3600)) return "ambient-interval"
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
    delivery: { quote: false },
    agent: { signal: context.signal as AbortSignal | undefined },
    execution: { background: false },
    observability: { trace: { id: `daily-still-${Date.now()}` } },
  })
  return record(result)
}

/** 记录最近一次走到判断阶段的结果；冷却、概率等门控跳过不覆盖它。 */
async function attempt(options: AttemptOptions): Promise<UnknownRecord> {
  const result = await runAttempt(options)
  const decision = record(result.decision)
  if (result.sent === true || result.decision || result.mood) {
    lastOutcome = {
      at: new Date().toISOString(),
      mode: options.mode,
      sent: result.sent === true,
      reason: text(result.reason || (result.sent ? "sent" : "")),
      mood: text(result.mood || record(decision.mood).name),
      pickMode: text(result.pickMode),
      source: text(decision.source || (result.pickMode === "image" ? "model" : result.pickMode === "latest" ? "latest" : options.mode === "idle" ? "idle" : "")),
      sendScore: decision.sendScore ?? null,
      confidence: decision.confidence ?? null,
    }
  }
  return result
}

async function runAttempt(options: AttemptOptions): Promise<UnknownRecord> {
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
    const gate = stickerExpressionGate(config, { lastSuccessAt: scopeState.lastSuccessAt, lastAttemptAt: lastAttempt, lastAmbientAttemptAt: scopeState.lastAmbientAttemptAt, sentCount: scopeState.sentCount }, now, options.mode)
    if (gate !== "ok") return { skipped: true, reason: gate }
  }
  if (!options.force && !stickerExpressionProbabilityHit(mode.probabilityPercent)) return { skipped: true, reason: "probability" }

  runningScopes.add(scope)
  attempts++
  if (options.dryRun !== true) {
    scopeState.lastAttemptAt = now
    if (options.mode === "ambient") scopeState.lastAmbientAttemptAt = now
    // 失败、取消和没有候选也算一次尝试；这样重启后不会立即重复调用模型。
    await persistState()
  }
  lastAttemptAt = now
  try {
    const choice = await chooseSticker({
      config: config as RuntimeConfigObject,
      cfg,
      event,
      mode: options.mode,
      userText: options.userText,
      replyText: options.replyText,
      contextText: options.contextText,
      scopeState,
      signal: options.event.signal as AbortSignal | undefined,
      // 判断期间有新消息或已被正常回复时放弃，避免插话。
      canceled: () => stale(scope, options.version) || (options.mode === "ambient" && event.__yuiChatReplied === true),
    })
    const { selection } = choice
    if (choice.skipped || !selection) return choice
    if (selection.status !== "selected" || !selection.selected || !selection.binding) {
      const diagnostics = Array.isArray(selection.errors) ? selection.errors : []
      if (diagnostics.length) lastError = diagnostics.map(item => text(record(item).message)).filter(Boolean).join("；").slice(0, 500)
      return { ...choice, skipped: true, reason: selection.reason || "no-candidate" }
    }
    if (options.dryRun === true) return { ...choice, skipped: false, dryRun: true }
    const currentConfig = configStore.get()
    const currentMode = modeConfig(currentConfig, options.mode)
    if (bindingSignature(currentConfig) !== bindingSignature(config)
      || configOf(currentConfig).enabled !== true
      || currentMode.enabled !== true
      || !isStickerExpressionScopeAllowed(event, currentConfig)
      || stale(scope, options.version)) {
      return { ...choice, skipped: true, reason: "stale-config" }
    }
    await ensureState()
    const latestState = stateFor(scope)
    const sendGate = stickerExpressionGate(currentConfig, {
      lastSuccessAt: latestState.lastSuccessAt,
      // 本次机会已经记录过尝试时间；发送前只重新检查成功冷却和配额。
      lastAttemptAt: 0,
      sentCount: latestState.sentCount,
    })
    if (sendGate === "cooldown" || sendGate === "daily-quota") return { ...choice, skipped: true, reason: `stale-${sendGate}` }
    const delivery = await sendCandidate(event, selection.selected, { config })
    if (!receiptSuccessful(delivery)) {
      lastError = text(record(delivery.value).error || delivery.error || "表情包投递失败")
      return { ...choice, skipped: true, reason: delivery.status || "delivery-failed", delivery }
    }
    const sentAt = Date.now()
    // 保存尝试会替换内存快照；回执必须写入当前作用域，不能继续修改旧引用。
    const deliveredState = stateFor(scope)
    deliveredState.sentCount += 1
    deliveredState.lastSuccessAt = sentAt
    deliveredState.recent.push({ binding: selection.binding.serverName, id: selection.selected.id, at: sentAt })
    deliveredState.recent = deliveredState.recent.slice(-MAX_RECENT)
    if (choice.moodGroup) deliveredState.moods = [...deliveredState.moods, { name: choice.moodGroup, at: sentAt }].slice(-MAX_RECENT_MOODS)
    recordStickerExpressionSentSeconds(scope, selection.binding.serverName, selection.selected.id, durationSeconds(cfg, "recentWindowSeconds", 21600, "", "recentWindowMinutes"))
    await persistState()
    lastSuccessAt = sentAt
    sent++
    event.__yuiChatReplied = true
    return { ...choice, skipped: false, sent: true, delivery }
  } catch (error) {
    lastError = text(error instanceof Error ? error.message : error).slice(0, 300)
    return { skipped: true, reason: "error", error: lastError }
  } finally {
    runningScopes.delete(scope)
  }
}

function clip(value: unknown, limit: number): string {
  const source = text(value).replace(/\s+/g, " ").trim()
  return source.length > limit ? `${source.slice(0, limit)}…` : source
}

/** 旁观窗口去掉首行说明，只保留最后几条消息并逐条截断。 */
function windowLines(contextText: string, maxMessages: number): string[] {
  const lines = text(contextText).split("\n").slice(1).map(line => clip(line, STATE_LINE_LIMIT)).filter(Boolean)
  return lines.slice(-Math.max(1, Math.floor(maxMessages)))
}

function decisionState(options: AttemptOptions): Record<string, JsonValue> {
  if (options.mode === "ambient") return { 最近群聊: windowLines(text(options.contextText), 6) }
  const state: Record<string, JsonValue> = { 对方: clip(options.userText, STATE_TEXT_LIMIT) }
  const reply = clip(options.replyText, STATE_TEXT_LIMIT)
  if (reply) state.我的回复 = reply
  return state
}

function selectionContext(config: RuntimeConfigObject, cfg: UnknownRecord, event: UnknownRecord) {
  return {
    e: event,
    config,
    toolConfig: {
      ...record(cfg.binding),
      recentWindowSeconds: durationSeconds(cfg, "recentWindowSeconds", 21600, "", "recentWindowMinutes"),
    },
  }
}

/** 最近在重复窗口内发过的情绪分组；窗口为 0 时不做去重。 */
function recentMoodNames(cfg: UnknownRecord, scopeState: PersistedScope, now = Date.now()): string[] {
  const windowMs = durationMs(cfg, "moodRepeatSeconds", 1800)
  if (windowMs <= 0) return []
  return [...new Set(scopeState.moods.filter(item => now - item.at < windowMs).map(item => item.name))]
}

/** 精选模式的语义检索词：对话用对方原话，旁观用最近三条消息。 */
function semanticQuery(options: Pick<ChooseOptions, "mode" | "userText" | "contextText">): string {
  if (options.mode === "ambient") return windowLines(text(options.contextText), 3).join(" ").slice(0, 300)
  return clip(options.userText, STATE_TEXT_LIMIT)
}

interface ChooseOptions {
  config: RuntimeConfigObject
  cfg: UnknownRecord
  event: UnknownRecord
  mode: AttemptOptions["mode"]
  userText?: string
  replyText?: string
  contextText?: string
  scopeState: PersistedScope
  signal?: AbortSignal
  /** 判断完成后、检索前检查一次；返回 true 时放弃本次表达。 */
  canceled?: () => boolean
}

type PickMode = "mood" | "image" | "latest"

/**
 * 每个入口单独配置选图方式：对话和旁观默认按情绪，冒泡默认取最新上传。
 * 旧版全局 pickMode 只作为对话和旁观的回退值。
 */
export function stickerExpressionPickMode(cfg: UnknownRecord, mode: AttemptOptions["mode"]): PickMode {
  const value = text(record(cfg[mode]).pick || (mode === "idle" ? "" : cfg.pickMode)).trim()
  if (mode === "idle") return value === "mood" ? "mood" : "latest"
  return value === "image" || value === "latest" ? value : "mood"
}

interface ChooseResult extends UnknownRecord {
  skipped?: boolean
  reason?: string
  /** mood：先判断情绪再按标签选图；image：语义召回后由决策模型挑图；latest：取最新上传。 */
  pickMode: PickMode
  decision?: DailyStillDecision | DailyStillImageDecision | null
  /** 展示用情绪文本；精选模式取图片描述里的首个心情词。 */
  mood?: string
  /** 精选模式退回情绪模式的原因，例如语义召回太少。 */
  pickFallback?: string
  /** 实际使用的情绪分组，发送成功后计入最近情绪。 */
  moodGroup?: string
  tags?: string[]
  selection?: StickerSelectionResult
}

/**
 * 判断是否发送并选出图片，不做冷却检查、不投递、不改状态。
 * 实际发送和管理台试运行共用这一段，保证两边行为一致。
 */
async function chooseSticker(options: ChooseOptions): Promise<ChooseResult> {
  const { config, cfg, event, scopeState } = options
  const moods = dailyStillMoods(cfg.moods)
  const recentMoods = recentMoodNames(cfg, scopeState)
  const expiry = Date.now() - durationMs(cfg, "recentWindowSeconds", 21600, "", "recentWindowMinutes")
  const excludeIds = new Set(scopeState.recent.filter(item => item.at > expiry).map(item => item.id))
  const context = selectionContext(config, cfg, event)
  const decisionConfig = record(cfg.decision)
  const pick = stickerExpressionPickMode(cfg, options.mode)
  if (pick === "latest") {
    // 不调用模型：取最近上传且本会话没发过的一张。
    return { pickMode: "latest", selection: await selectLatestSticker(context, { excludeIds }) }
  }
  if (options.mode === "idle") {
    // 冒泡没有聊天内容可判断，从空闲分组里随机取一种最近没发过的情绪，同样不调用模型。
    const mood = pickIdleMood(moods, record(cfg.idle).moods, new Date(), Math.random(), recentMoods)
    if (!mood) return { pickMode: "mood", skipped: true, reason: "no-idle-mood" }
    const selection = await selectStickerByTags({ tags: mood.tags, fallbackKeyword: mood.name }, context, { excludeIds })
    return { pickMode: "mood", mood: mood.name, moodGroup: mood.name, tags: mood.tags, selection }
  }
  // 对话和旁观可以限定候选分组；留空表示字典里的全部分组。
  const entryMoods = list(record(cfg[options.mode]).moods)
  const candidateMoods = entryMoods.length ? moods.filter(mood => entryMoods.includes(mood.name)) : moods
  const decisionInput = {
    config,
    decision: decisionConfig,
    moods: candidateMoods,
    state: decisionState(options),
    plainText: [options.userText, options.replyText, options.contextText].map(text).join("\n"),
    event,
    signal: options.signal,
  }
  let pickFallback = ""
  if (pick === "image" && dailyStillDecisionAvailable(decisionInput)) {
    // 精选模式先检索再判断：每次都会调用图库，但决策模型直接在图片之间挑选。
    const pool = await searchStickersBySemantic(semanticQuery(options), context, { excludeIds, count: number(cfg.imagePoolSize, 20) })
    // 语义检索有相关度门槛，整句聊天常常召回很少；候选太少时退回情绪模式。
    if (pool.status === "ok" && pool.pool.length >= MIN_IMAGE_POOL) {
      const decision = await decideDailyStillImage(decisionInput, pool.pool.map(item => ({ id: item.id, description: item.description })))
      if (decision.error) lastError = decision.error
      const picked = pool.pool.find(item => item.id === decision.pickedId) || null
      const mood = picked ? parseStillDescription(picked.description).moods[0] || "" : ""
      if (!decision.send || !picked) return { pickMode: "image", skipped: true, reason: decision.reason, decision, mood, selection: stickerPoolSelection(pool, null, decision.reason) }
      if (options.canceled?.()) return { pickMode: "image", skipped: true, reason: "canceled-after-decision", decision, mood }
      return { pickMode: "image", decision, mood, selection: stickerPoolSelection(pool, picked) }
    }
    pickFallback = pool.status === "ok" ? `semantic-pool-${pool.pool.length}` : "semantic-search-failed"
  }
  const fallback = pickFallback ? { pickFallback } : {}
  const raw = await decideDailyStill(decisionInput)
  if (raw.error) lastError = raw.error
  const decision = avoidRepeatedMood(raw, conversationMoods(candidateMoods), recentMoods, number(decisionConfig.moodConfidence, 0.3))
  if (!decision.send || !decision.mood) return { pickMode: "mood", ...fallback, skipped: true, reason: decision.reason, decision }
  const mood = decision.mood
  if (options.canceled?.()) return { pickMode: "mood", ...fallback, skipped: true, reason: "canceled-after-decision", decision, mood: mood.name }
  const selection = await selectStickerByTags({ tags: mood.tags, fallbackKeyword: mood.name }, context, { excludeIds })
  return { pickMode: "mood", ...fallback, decision, mood: mood.name, moodGroup: mood.name, tags: mood.tags, selection }
}

interface PreviewOptions {
  config?: unknown
  event: UnknownRecord
  mode?: "conversation" | "ambient" | "idle"
  text?: string
  reply?: string
}

/** 管理台试运行：走完整的判断与选图，但不检查冷却、不发送、不计入配额。 */
async function preview(options: PreviewOptions): Promise<UnknownRecord> {
  const config = (options.config || await configStore.load()) as RuntimeConfigObject
  const cfg = configOf(config)
  const event = normalizeEventScope(options.event)
  await ensureState()
  const mode = options.mode || "conversation"
  const result = await chooseSticker({
    config,
    cfg,
    event,
    mode,
    scopeState: stateFor(scopeKey(event)),
    ...(mode === "ambient" ? { contextText: `群聊窗口\n${text(options.text)}` } : { userText: options.text, replyText: options.reply }),
  })
  const ok = !result.skipped && result.selection?.status === "selected"
  return { ...result, ok, reason: result.reason || result.selection?.reason || "" }
}

let lastGalleryStats: (GalleryStats & { at: string }) | null = null

/** 扫描图库并统计心情词与分组覆盖；只在管理台手动触发。 */
async function galleryStats(options: { config?: unknown; maxPages?: number } = {}): Promise<UnknownRecord> {
  const config = (options.config || await configStore.load()) as RuntimeConfigObject
  const cfg = configOf(config)
  const scan = await scanStickerGallery(selectionContext(config, cfg, {}), { maxPages: options.maxPages })
  if (scan.status !== "ok") return { ok: false, reason: scan.reason || "图库扫描失败", errors: scan.errors }
  lastGalleryStats = { ...summarizeGallery(scan.pool, dailyStillMoods(cfg.moods), scan.total), at: new Date().toISOString() }
  return { ok: true, stats: lastGalleryStats }
}

class StickerExpressionCoordinator {
  start(config: unknown = {}): UnknownRecord {
    this.stop()
    const cfg = configOf(config)
    const idle = record(cfg.idle)
    if (cfg.enabled === false || idle.enabled !== true || !list(idle.groups).length) return this.stats()
    const intervalMs = Math.max(1, durationSeconds(idle, "intervalSeconds", 3600, "", "intervalMinutes")) * 1000
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
    return attempt({
      config: options.config as RuntimeConfigObject,
      event: e,
      mode: "conversation",
      userText: text(options.prompt || e.msg || e.raw_message),
      replyText: text(options.botText),
    })
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
    const windowMs = Math.max(1000, durationMs(ambient, "windowSeconds", 20, "windowMs"))
    const timerValue = setTimeout(() => {
      pendingWindows.delete(scope)
      void attempt({ config: configStore.get(), event: e, mode: "ambient", contextText: boundedContext(e, number(ambient.maxMessages, 6), durationMs(configOf(configStore.get()), "contextTtlSeconds", 900, "contextTtlMs")), version }).catch(error => { lastError = text(error) })
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
      if (!lastMessageAt || Date.now() - lastMessageAt < Math.max(1, durationSeconds(idle, "minIdleSeconds", 3600, "", "minIdleMinutes")) * 1000) {
        results.push({ groupId, skipped: true, reason: "not-idle" }); continue
      }
      const version = versions.get(scopeKey(event)) || 0
      results.push(await attempt({ config: config as RuntimeConfigObject, event, mode: "idle", version, force: options.force === true, dryRun: options.dryRun === true }))
    }
    nextRunAt = timer ? Date.now() + Math.max(1, durationSeconds(idle, "intervalSeconds", 3600, "", "intervalMinutes")) * 1000 : 0
    return { groups: groups.length, results }
  }

  async preview(options: PreviewOptions): Promise<UnknownRecord> {
    return preview(options)
  }

  async galleryStats(options: { config?: unknown; maxPages?: number } = {}): Promise<UnknownRecord> {
    return galleryStats(options)
  }

  async clearState(): Promise<UnknownRecord> {
    await ensureState()
    const count = Object.keys(state.scopes).length
    state = { scopes: {} }
    // persistState 按作用域合并；清空时直接写入空状态。
    await stateRepository.update(() => ({ scopes: {} }))
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
      lastOutcome,
      galleryStats: lastGalleryStats,
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
  current.recent = current.recent.slice(-MAX_RECENT)
  const cfg = configOf(configStore.get())
  recordStickerExpressionSentSeconds(scope, server, selectedId, durationSeconds(cfg, "recentWindowSeconds", 21600, "", "recentWindowMinutes"))
  lastSuccessAt = now
  sent++
  await persistState()
}
