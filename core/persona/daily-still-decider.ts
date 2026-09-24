import { adapterRegistry } from "../../models/adapters/registry.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import { conversationMoods, matchMoodByKeywords, parseStillDescription, type DailyStillMood } from "./daily-still-moods.js"
import type { JsonValue } from "../message-chain/types.js"
import type { DecisionAnswer, DecisionQuestion } from "../../models/protocol/types.js"
import type { RuntimeConfigObject } from "../../config/types.js"

type UnknownRecord = Record<string, unknown>

export interface DailyStillDecisionInput {
  config: RuntimeConfigObject
  /** persona.stickerExpression.decision 配置。 */
  decision: UnknownRecord
  moods: DailyStillMood[]
  /** 交给决策模型的内容；本地关键词判断使用 plainText。 */
  state: Record<string, JsonValue>
  plainText: string
  event?: unknown
  signal?: AbortSignal
  now?: Date
}

export interface DailyStillDecision {
  send: boolean
  reason: string
  /** model：由决策模型判断；keywords：未配置或模型失败时的本地关键词判断。 */
  source: "model" | "keywords"
  mood: DailyStillMood | null
  sendScore: number | null
  confidence: number | null
  probabilities: Record<string, number>
  model: string
  error: string
  /** 因最近发过同一情绪而改选时，记录原本选中的情绪。 */
  repeatAvoided?: string
}

/** 精选模式的候选图片；描述用于生成选项说明。 */
export interface DailyStillImageOption {
  id: string
  description: string
}

export interface DailyStillImageDecision {
  send: boolean
  reason: string
  /** 选中的图片 ID；未选中时为空。 */
  pickedId: string
  sendScore: number | null
  confidence: number | null
  /** 以图片 ID 为键的概率分布。 */
  probabilities: Record<string, number>
  model: string
  error: string
}

const NONE = "none"
const OPTION_LABEL_LIMIT = 60

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function clamp(value: unknown, fallback: number, min = 0, max = 1): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function errorText(error: unknown, fallback: string): string {
  return text(error instanceof Error ? error.message : error).slice(0, 300) || fallback
}

const SEND_NOW_QUESTION: DecisionQuestion = {
  type: "noul",
  instructions: "作为群聊里的朋友，此刻顺手发一张表情包回应是否自然？",
  criteria: {
    true: "内容带有明显情绪、玩笑、吐槽、感谢、问候或闲聊气氛，发表情包能自然接话",
    false: "严肃求助、技术讨论、事实问答、争执、敏感话题，或内容平淡没有情绪",
  },
}

export function dailyStillDecisionQuestions(moods: DailyStillMood[]): Record<string, DecisionQuestion> {
  const criteria: Record<string, JsonValue> = {}
  for (const mood of moods) criteria[mood.name] = mood.description || mood.tags.join("、")
  criteria[NONE] = "没有明确情绪，或者不适合用表情包回应"
  return {
    send_now: SEND_NOW_QUESTION,
    mood: {
      type: "choice",
      instructions: "最适合用哪种情绪的表情包回应？",
      criteria,
    },
  }
}

/** 精选模式的选项说明：心情/氛围 + 表述含义，截断到约 60 字。 */
export function dailyStillImageOptionLabel(description: string): string {
  const parsed = parseStillDescription(description)
  const parts = [parsed.moods.length ? `心情：${parsed.moods.join("、")}` : "", parsed.meaning ? `含义：${parsed.meaning}` : ""].filter(Boolean)
  const label = (parts.length ? parts.join("；") : text(description)).replace(/\s+/g, " ").trim()
  return label.length > OPTION_LABEL_LIMIT ? `${label.slice(0, OPTION_LABEL_LIMIT)}…` : label
}

/** 选项键用“图1、图2…”，避免图库 ID 格式影响模型理解。 */
export function dailyStillImageQuestions(options: DailyStillImageOption[]): { questions: Record<string, DecisionQuestion>; keys: Map<string, string> } {
  const criteria: Record<string, JsonValue> = {}
  const keys = new Map<string, string>()
  options.forEach((option, index) => {
    const key = `图${index + 1}`
    keys.set(key, option.id)
    criteria[key] = dailyStillImageOptionLabel(option.description) || "（无描述）"
  })
  criteria[NONE] = "没有一张适合当前语境"
  return {
    questions: {
      send_now: SEND_NOW_QUESTION,
      pick: { type: "choice", instructions: "哪张表情包最适合用来回应？", criteria },
    },
    keys,
  }
}

function keywordDecision(input: DailyStillDecisionInput, moods: DailyStillMood[], error = ""): DailyStillDecision {
  const matched = matchMoodByKeywords(moods, input.plainText)
  return {
    send: Boolean(matched),
    reason: matched ? "keywords-matched" : "keywords-no-match",
    source: "keywords",
    mood: matched?.mood || null,
    sendScore: null,
    confidence: null,
    probabilities: {},
    model: "",
    error,
  }
}

type ChannelLookup = { channel: NonNullable<ReturnType<typeof providerResolver.resolveCandidateChannels>[number]> } | { error: string }

/** 解析配置的决策模型；空字符串表示未配置。 */
function decisionChannel(input: Pick<DailyStillDecisionInput, "config" | "decision">): ChannelLookup | null {
  const modelName = text(input.decision.model).trim()
  if (!modelName) return null
  const channel = providerResolver.resolveCandidateChannels({ channelId: modelName, config: input.config })[0]
  if (!channel || channel.purpose !== "decision") return { error: `决策模型不可用：${modelName}` }
  return { channel }
}

async function ask(input: DailyStillDecisionInput, channel: Extract<ChannelLookup, { channel: unknown }>["channel"], questions: Record<string, DecisionQuestion>) {
  const timeoutMs = clamp(input.decision.timeoutSeconds, 10, 1, 120) * 1000
  return adapterRegistry.decide({
    channel: { ...channel, timeoutMs },
    state: input.state,
    questions,
    signal: input.signal,
    event: input.event,
    source: "dailyStill.decision",
    taskName: "dailyStill",
  })
}

/** 是否配置了可用的决策模型；精选模式依赖它，未配置时退回情绪模式。 */
export function dailyStillDecisionAvailable(input: Pick<DailyStillDecisionInput, "config" | "decision">): boolean {
  const lookup = decisionChannel(input)
  return Boolean(lookup && "channel" in lookup)
}

/**
 * 判断此刻是否发送以及发送哪种情绪。
 *
 * 配置了决策模型时，一次请求同时问“是否发送”和“哪种情绪”；未配置、
 * 渠道不是决策用途或请求失败时，改用本地关键词判断，不额外调用对话模型。
 */
export async function decideDailyStill(input: DailyStillDecisionInput): Promise<DailyStillDecision> {
  const moods = conversationMoods(input.moods, input.now)
  if (!moods.length) return { ...keywordDecision(input, moods), send: false, reason: "no-moods" }
  const lookup = decisionChannel(input)
  if (!lookup) return keywordDecision(input, moods)
  if ("error" in lookup) return keywordDecision(input, moods, lookup.error)
  try {
    const result = await ask(input, lookup.channel, dailyStillDecisionQuestions(moods))
    const sendScore = clamp(result.answers.send_now?.noul, 0)
    const moodAnswer: DecisionAnswer = result.answers.mood || { type: "choice" }
    const confidence = clamp(moodAnswer.confidence, 0)
    const mood = moods.find(item => item.name === moodAnswer.choice) || null
    const base = { source: "model" as const, mood, sendScore, confidence, probabilities: moodAnswer.probabilities || {}, model: result.model, error: "" }
    if (sendScore < clamp(input.decision.sendThreshold, 0.6)) return { ...base, send: false, reason: "not-a-moment" }
    if (!mood) return { ...base, send: false, reason: "no-mood" }
    if (confidence < clamp(input.decision.moodConfidence, 0.3)) return { ...base, send: false, reason: "mood-uncertain" }
    return { ...base, send: true, reason: "model-selected" }
  } catch (error) {
    return keywordDecision(input, moods, errorText(error, "决策请求失败"))
  }
}

/**
 * 精选模式：一次请求同时判断“是否发送”和“发哪张”。
 * 只在配置了决策模型时使用；请求失败直接跳过，不回退关键词选图。
 */
export async function decideDailyStillImage(input: DailyStillDecisionInput, options: DailyStillImageOption[]): Promise<DailyStillImageDecision> {
  const empty = { send: false, pickedId: "", sendScore: null, confidence: null, probabilities: {}, model: "", error: "" }
  if (!options.length) return { ...empty, reason: "no-candidate" }
  const lookup = decisionChannel(input)
  if (!lookup) return { ...empty, reason: "no-decision-model" }
  if ("error" in lookup) return { ...empty, reason: "no-decision-model", error: lookup.error }
  const { questions, keys } = dailyStillImageQuestions(options)
  try {
    const result = await ask(input, lookup.channel, questions)
    const sendScore = clamp(result.answers.send_now?.noul, 0)
    const pick: DecisionAnswer = result.answers.pick || { type: "choice" }
    const confidence = clamp(pick.confidence, 0)
    const pickedId = keys.get(text(pick.choice)) || ""
    const probabilities: Record<string, number> = {}
    for (const [key, value] of Object.entries(pick.probabilities || {})) probabilities[keys.get(key) || key] = value
    const base = { pickedId, sendScore, confidence, probabilities, model: result.model, error: "" }
    if (sendScore < clamp(input.decision.sendThreshold, 0.6)) return { ...base, send: false, reason: "not-a-moment" }
    if (!pickedId) return { ...base, send: false, reason: "no-image-fit" }
    if (confidence < clamp(input.decision.moodConfidence, 0.3)) return { ...base, send: false, reason: "image-uncertain" }
    return { ...base, send: true, reason: "model-picked" }
  } catch (error) {
    return { ...empty, reason: "decision-error", error: errorText(error, "决策请求失败") }
  }
}

/**
 * 最近发过同一情绪时，改用概率足够高的次选情绪；没有合适次选时保持原选择，
 * 图片本身仍按已发送记录去重。关键词判断没有概率分布，不做改选。
 */
export function avoidRepeatedMood(decision: DailyStillDecision, moods: DailyStillMood[], recentMoods: string[], minProbability: number): DailyStillDecision {
  if (!decision.send || !decision.mood || decision.source !== "model" || !recentMoods.includes(decision.mood.name)) return decision
  const alternative = Object.entries(decision.probabilities)
    .filter(([name, probability]) => name !== NONE && name !== decision.mood?.name && !recentMoods.includes(name) && probability >= minProbability)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => moods.find(mood => mood.name === name))
    .find((mood): mood is DailyStillMood => Boolean(mood))
  if (!alternative) return decision
  return { ...decision, mood: alternative, confidence: decision.probabilities[alternative.name] ?? decision.confidence, repeatAvoided: decision.mood.name }
}
