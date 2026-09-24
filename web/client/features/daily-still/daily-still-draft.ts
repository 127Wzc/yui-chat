import { asRecord, type UnknownRecord } from "../../shared/data.js"

// 日常定格页的草稿模型：配置与表单之间的双向转换，页面和子组件共用。

export interface MoodDraft {
  name: string
  tags: string
  description: string
  keywords: string
  hours: string
  idleOnly: boolean
}

export interface DailyStillDraft {
  enabled: boolean
  privateEnabled: boolean
  allowlist: string
  blocklist: string
  conversationEnabled: boolean
  conversationProbability: number
  ambientEnabled: boolean
  ambientProbability: number
  ambientWindowSeconds: number
  ambientMaxMessages: number
  idleEnabled: boolean
  idleProbability: number
  idleGroups: string
  idleIntervalMinutes: number
  idleMinIdleMinutes: number
  idleStart: string
  idleEnd: string
  idleMoods: string[]
  decisionModel: string
  sendThreshold: number
  moodConfidence: number
  decisionTimeoutSeconds: number
  conversationPick: string
  conversationMoods: string[]
  ambientMoods: string[]
  ambientPick: string
  idlePick: string
  imagePoolSize: number
  moodRepeatMinutes: number
  cooldownMinutes: number
  attemptIntervalSeconds: number
  dailyQuota: number
  recentWindowHours: number
  contextTtlSeconds: number
  primaryTool: string
  fallbackTool: string
  candidateCount: number
  topK: number
  adapterConfigs: UnknownRecord
  adapterConfigJson: string
  moods: MoodDraft[]
}

export const DEFAULT_TOOL = "mcp_imagTag-mcp_search_images"
export const DEFAULT_IDLE_MOODS = ["冒泡", "摸鱼", "吃瓜", "发呆", "卖萌", "早安", "晚安"]

export function text(value: unknown): string { return typeof value === "string" ? value : String(value ?? "") }
export function number(value: unknown, fallback: number): number { const n = Number(value); return value !== "" && Number.isFinite(n) ? n : fallback }
export function seconds(value: unknown, fallback: number, legacyMs?: unknown, legacyMinutes?: unknown): number {
  if (value !== undefined && Number.isFinite(Number(value))) return Math.max(0, Number(value))
  if (legacyMs !== undefined && Number.isFinite(Number(legacyMs))) return Math.max(0, Number(legacyMs) / 1000)
  if (legacyMinutes !== undefined && Number.isFinite(Number(legacyMinutes))) return Math.max(0, Number(legacyMinutes) * 60)
  return fallback
}
export function round(value: number, digits = 2): number { const scale = 10 ** digits; return Math.round(value * scale) / scale }
export function bool(value: unknown, fallback = false): boolean { return typeof value === "boolean" ? value : fallback }
export function list(value: unknown): string[] { return (Array.isArray(value) ? value : text(value).split(/[\s\n,，、|]+/)).map(text).map(item => item.trim()).filter(Boolean) }
export function join(value: unknown, separator = ", "): string { return list(value).join(separator) }
export function objectJson(value: unknown): string {
  const source = asRecord(value)
  return Object.keys(source).length ? JSON.stringify(source, null, 2) : ""
}
export function parseObjectJson(value: string): UnknownRecord | null {
  const source = value.trim()
  if (!source) return {}
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : null
  } catch {
    return null
  }
}

export function moodDraft(value: unknown): MoodDraft {
  const item = asRecord(value)
  return {
    name: text(item.name),
    tags: join(item.tags, " "),
    description: text(item.description),
    keywords: join(item.keywords, " "),
    hours: text(item.hours),
    idleOnly: item.idleOnly === true,
  }
}

export function moodValue(item: MoodDraft): UnknownRecord {
  return {
    name: item.name.trim(),
    description: item.description.trim(),
    tags: list(item.tags),
    keywords: list(item.keywords),
    idleOnly: item.idleOnly,
    hours: item.hours.trim(),
  }
}

export function initDraft(config: UnknownRecord, moods: unknown[]): DailyStillDraft {
  const cfg = asRecord(asRecord(config.persona).stickerExpression)
  const binding = asRecord(cfg.binding)
  const conversation = asRecord(cfg.conversation)
  const ambient = asRecord(cfg.ambient)
  const idle = asRecord(cfg.idle)
  const hours = asRecord(idle.allowedHours)
  const scope = asRecord(cfg.groupScope)
  const decision = asRecord(cfg.decision)
  const primaryTool = text(binding.primaryTool || binding.tool || DEFAULT_TOOL)
  const adapterConfigs = asRecord(binding.adapterConfigs)
  return {
    enabled: bool(cfg.enabled),
    privateEnabled: bool(cfg.privateEnabled),
    allowlist: join(scope.allowlist, "\n"),
    blocklist: join(scope.blocklist, "\n"),
    conversationEnabled: bool(conversation.enabled),
    conversationProbability: number(conversation.probabilityPercent, 50),
    ambientEnabled: bool(ambient.enabled),
    ambientProbability: number(ambient.probabilityPercent, 30),
    ambientWindowSeconds: seconds(ambient.windowSeconds, 20, ambient.windowMs),
    ambientMaxMessages: number(ambient.maxMessages, 6),
    idleEnabled: bool(idle.enabled),
    idleProbability: number(idle.probabilityPercent, 30),
    idleGroups: join(idle.groups, "\n"),
    idleIntervalMinutes: round(seconds(idle.intervalSeconds, 1800, undefined, idle.intervalMinutes) / 60),
    idleMinIdleMinutes: round(seconds(idle.minIdleSeconds, 3600, undefined, idle.minIdleMinutes) / 60),
    idleStart: text(hours.start || "09:00"),
    idleEnd: text(hours.end || "23:30"),
    idleMoods: Array.isArray(idle.moods) ? list(idle.moods) : [...DEFAULT_IDLE_MOODS],
    decisionModel: text(decision.model),
    sendThreshold: number(decision.sendThreshold, 0.6),
    moodConfidence: number(decision.moodConfidence, 0.3),
    decisionTimeoutSeconds: number(decision.timeoutSeconds, 10),
    conversationPick: text(conversation.pick || cfg.pickMode || "mood"),
    conversationMoods: list(conversation.moods),
    ambientMoods: list(ambient.moods),
    ambientPick: text(ambient.pick || cfg.pickMode || "mood"),
    idlePick: text(idle.pick) === "mood" ? "mood" : "latest",
    imagePoolSize: number(cfg.imagePoolSize, 20),
    moodRepeatMinutes: round(seconds(cfg.moodRepeatSeconds, 1800) / 60),
    cooldownMinutes: round(seconds(cfg.cooldownSeconds, 1200, cfg.cooldownMs) / 60),
    attemptIntervalSeconds: seconds(cfg.attemptIntervalSeconds, 120, cfg.attemptIntervalMs),
    dailyQuota: number(cfg.dailyQuota, 8),
    recentWindowHours: round(seconds(cfg.recentWindowSeconds, 259200, undefined, cfg.recentWindowMinutes) / 3600),
    contextTtlSeconds: seconds(cfg.contextTtlSeconds, 900, cfg.contextTtlMs),
    primaryTool,
    fallbackTool: text(binding.fallbackTool),
    candidateCount: number(binding.candidateCount, 30),
    topK: number(binding.topK, 8),
    adapterConfigs,
    adapterConfigJson: objectJson(adapterConfigs[primaryTool]),
    moods: moods.map(moodDraft),
  }
}

export function buildConfig(draft: DailyStillDraft, defaultMoods: unknown[]): UnknownRecord {
  const adapterConfigs = { ...draft.adapterConfigs }
  const adapterConfig = parseObjectJson(draft.adapterConfigJson)
  const primaryTool = draft.primaryTool.trim() || DEFAULT_TOOL
  if (adapterConfig) adapterConfigs[primaryTool] = adapterConfig
  const moods = draft.moods.map(moodValue).filter(item => item.name)
  // 与内置分组一致时不写入配置，后续版本调整默认分组可以直接生效。
  const moodsChanged = JSON.stringify(moods) !== JSON.stringify(defaultMoods.map(item => moodValue(moodDraft(item))))
  return {
    enabled: draft.enabled,
    privateEnabled: draft.privateEnabled,
    groupScope: { allowlist: list(draft.allowlist), blocklist: list(draft.blocklist) },
    conversation: { enabled: draft.conversationEnabled, probabilityPercent: draft.conversationProbability, pick: draft.conversationPick, moods: [...draft.conversationMoods] },
    ambient: { enabled: draft.ambientEnabled, probabilityPercent: draft.ambientProbability, windowSeconds: draft.ambientWindowSeconds, maxMessages: draft.ambientMaxMessages, pick: draft.ambientPick, moods: [...draft.ambientMoods] },
    idle: {
      enabled: draft.idleEnabled,
      probabilityPercent: draft.idleProbability,
      groups: list(draft.idleGroups),
      intervalSeconds: Math.round(number(draft.idleIntervalMinutes, 30) * 60),
      minIdleSeconds: Math.round(number(draft.idleMinIdleMinutes, 60) * 60),
      allowedHours: { start: draft.idleStart, end: draft.idleEnd },
      moods: [...draft.idleMoods],
      pick: draft.idlePick,
    },
    decision: {
      model: draft.decisionModel,
      sendThreshold: draft.sendThreshold,
      moodConfidence: draft.moodConfidence,
      timeoutSeconds: draft.decisionTimeoutSeconds,
    },
    ...(moodsChanged ? { moods } : {}),
    imagePoolSize: draft.imagePoolSize,
    moodRepeatSeconds: Math.round(number(draft.moodRepeatMinutes, 30) * 60),
    cooldownSeconds: Math.round(number(draft.cooldownMinutes, 20) * 60),
    attemptIntervalSeconds: draft.attemptIntervalSeconds,
    dailyQuota: draft.dailyQuota,
    recentWindowSeconds: Math.round(number(draft.recentWindowHours, 72) * 3600),
    contextTtlSeconds: draft.contextTtlSeconds,
    binding: {
      primaryTool,
      fallbackTool: draft.fallbackTool.trim(),
      tool: primaryTool,
      candidateCount: draft.candidateCount,
      topK: draft.topK,
      adapterConfigs,
    },
  }
}
