import { applyOutputFilters } from "../../filters/message/message-filter-service.js"
import { userSettingsStore } from "../../user/settings.js"
import { stripForSpeech, synthesizeSpeech } from "../media/tts-service.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { convertCQCodes } from "../message/cq-code.js"
import type { UnknownRecord } from "../message/types.js"
import { armConversationContinuation } from "../persona/conversation-continuation.js"
import { buildReplyPayload, isEmptyResponse } from "./response-pipeline.js"

type ReplyMethod = (payload: unknown, quote?: unknown, options?: UnknownRecord) => unknown | Promise<unknown>
type SegmentationOptions = UnknownRecord & {
  maxParts?: unknown
  minChars?: unknown
  minPartChars?: unknown
  thresholdChars?: unknown
  mode?: unknown
  regex?: unknown
  contentFilterRegex?: unknown
  intervalMethod?: unknown
  intervalMinSeconds?: unknown
  intervalMaxSeconds?: unknown
}

const configuredSegmentationMaxParts = 8
const defaultSegmentationRegex = ".*?[。？！!?；;~…]+|.+$"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function replyMethod(event: unknown): ReplyMethod {
  const reply = record(event).reply
  if (typeof reply !== "function") throw new Error("当前事件不支持回复消息")
  return reply as ReplyMethod
}

async function sendReply(event: unknown, payload: unknown, quote: unknown, options: UnknownRecord): Promise<unknown> {
  return replyMethod(event).call(event, payload, quote, options)
}

function markReplied(event: unknown): void {
  record(event).__yuiChatReplied = true
}

function responseConfig(config: unknown): UnknownRecord {
  return record(record(config).response)
}

function segmentFactory(): YuiChatHostSegmentFactory | undefined {
  return hostRuntime.segment
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function splitNaturalReply(value: unknown = "", options: SegmentationOptions = {}): string[] {
  const source = text(value).trim()
  const maxParts = Math.max(1, Math.min(configuredSegmentationMaxParts, number(options.maxParts, 3)))
  const minChars = Math.max(0, number(options.minChars))
  const minPartChars = Math.max(1, number(options.minPartChars, 1))
  if (!source || maxParts <= 1 || source.length < minChars || /```/.test(source)) return source ? [source] : []
  const parts: string[] = []
  let current = ""
  let lastCutIndex = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    current += character
    if (!/[。！？!?；;\n]/.test(character) || current.trim().length < minPartChars) continue
    const trimmed = current.trim()
    if (trimmed) parts.push(trimmed)
    current = ""
    lastCutIndex = index + 1
    if (parts.length >= maxParts - 1) break
  }
  const rest = source.slice(lastCutIndex).trim()
  if (rest) parts.push(rest)
  return parts.map(part => part.trim()).filter(Boolean).slice(0, maxParts)
}

function capSegmentationParts(parts: string[], maxParts = configuredSegmentationMaxParts): string[] {
  const limit = Math.max(1, Math.min(configuredSegmentationMaxParts, number(maxParts, configuredSegmentationMaxParts)))
  if (parts.length <= limit) return parts
  return [...parts.slice(0, limit - 1), parts.slice(limit - 1).join("\n")]
}

function applyContentFilter(parts: string[], pattern: unknown): string[] {
  const source = text(pattern).trim()
  if (!source) return parts
  try {
    const filter = new RegExp(source, "gmsu")
    return parts.map(part => part.replace(filter, "").trim()).filter(Boolean)
  } catch {
    return parts
  }
}

export function splitConfiguredReply(value: unknown = "", options: SegmentationOptions = {}): string[] {
  const source = text(value).trim()
  if (!source || /```/.test(source)) return source ? [source] : []
  const thresholdChars = Math.max(0, number(options.thresholdChars))
  if (thresholdChars > 0 && source.length >= thresholdChars) return [source]

  const mode = text(options.mode || "regex").trim().toLowerCase()
  let parts: string[]
  if (mode === "natural") {
    parts = splitNaturalReply(source, { maxParts: configuredSegmentationMaxParts, minChars: 0, minPartChars: 1 })
  } else {
    const expression = text(options.regex || defaultSegmentationRegex).trim() || defaultSegmentationRegex
    let matcher: RegExp
    try {
      matcher = new RegExp(expression, "gmsu")
    } catch {
      return [source]
    }
    parts = []
    let cursor = 0
    for (const match of source.matchAll(matcher)) {
      const valueMatch = text(match[0])
      const start = number(match.index, -1)
      if (!valueMatch || start < 0) continue
      const end = start + valueMatch.length
      if (end <= cursor) continue
      const part = source.slice(cursor, end).trim()
      if (part) parts.push(part)
      cursor = end
    }
    if (cursor < source.length) {
      const rest = source.slice(cursor).trim()
      if (rest) parts.push(rest)
    }
    if (!parts.length) parts = [source]
  }

  const filtered = applyContentFilter(capSegmentationParts(parts), options.contentFilterRegex)
  return filtered.length ? filtered : [source]
}

export function configuredSegmentationDelayMs(options: SegmentationOptions = {}, charCount = 0): number {
  const minSeconds = Math.max(0, number(options.intervalMinSeconds))
  const maxSeconds = Math.max(minSeconds, number(options.intervalMaxSeconds))
  if (maxSeconds <= 0) return 0
  const method = text(options.intervalMethod || "random").trim().toLowerCase()
  const rawSeconds = method === "log"
    ? Math.log10(Math.max(1, number(charCount, 1)))
    : minSeconds + Math.random() * (maxSeconds - minSeconds)
  return Math.round(Math.min(maxSeconds, Math.max(minSeconds, rawSeconds)) * 1000)
}

async function sendConfiguredSplitText(event: unknown, value: string, config: unknown, replyOptions: UnknownRecord): Promise<unknown> {
  const response = responseConfig(config)
  const segmentation = record(response.segmentation) as SegmentationOptions
  const parts = splitConfiguredReply(value, segmentation)
  const quoteReply = response.quoteReply
  const removeUnsupported = response.removeCQCode !== false
  if (parts.length <= 1) return sendReply(event, convertCQCodes(value, { removeUnsupported }), quoteReply, replyOptions)
  for (const [index, part] of parts.entries()) {
    await sendReply(event, convertCQCodes(part, { removeUnsupported }), index === 0 ? quoteReply : false, replyOptions)
    if (index < parts.length - 1) {
      const delayMs = configuredSegmentationDelayMs(segmentation, part.length)
      if (delayMs > 0) await sleep(delayMs)
    }
  }
  return true
}

function isLlmResult(result: UnknownRecord, source: string): boolean {
  if (source === "subagent" || source === "tool" || result.channel === "poke-fallback" || result.source === "poke-fallback") return false
  if (Array.isArray(result.steps) && result.steps.length) {
    return result.steps.some(step => record(step).status === "ok")
  }
  return true
}

function rememberDeliveredConversation(event: unknown, result: UnknownRecord, source: string, botText: unknown, options: UnknownRecord): void {
  if (options.armContinuation === false || !isLlmResult(result, source)) return
  const e = record(event)
  armConversationContinuation(event, e.msg || e.raw_message, botText)
}

async function sendRecordDelivery(event: unknown, data: unknown, quote: unknown, replyOptions: UnknownRecord): Promise<void> {
  const recordFactory = segmentFactory()?.record
  if (typeof recordFactory === "function") await sendReply(event, recordFactory(data), quote, replyOptions)
  else await sendReply(event, "[语音已生成，但当前适配器不支持 segment.record]", quote, replyOptions)
}

/** 将模型结果、过滤器交付物和用户选择的输出模式统一投递到宿主。 */
export async function sendChatOutput(event: unknown, result: unknown, config: unknown, options: UnknownRecord = {}): Promise<unknown> {
  const resultValue = record(result)
  const rootConfig = record(config)
  const response = responseConfig(rootConfig)
  const settings = await userSettingsStore.get(event, rootConfig)
  const replyOptions = record(options.replyOptions)
  if (isEmptyResponse(resultValue.text)) {
    markReplied(event)
    return true
  }

  const source = text(options.source || resultValue.source)
  const processed = await applyOutputFilters(resultValue.text, { event, e: event, config: rootConfig, result: resultValue, source })
  for (const delivery of processed.deliveries) await sendRecordDelivery(event, delivery.data, response.quoteReply, replyOptions)
  if (!processed.text) {
    markReplied(event)
    if (processed.deliveries.length) rememberDeliveredConversation(event, resultValue, source, resultValue.text, options)
    return true
  }

  const persona = record(rootConfig.persona)
  const firstPersonOutput = source === "firstPerson"
  const omitPrefix = firstPersonOutput && record(record(persona).output).omitChannelPrefixInFirstPerson !== false
  const rawText = omitPrefix ? processed.text : `[${text(resultValue.channel)}] ${processed.text}`
  const payload = await buildReplyPayload(rawText, rootConfig, {
    forceImage: settings.mode === "picture",
    e: event,
    result: resultValue,
    source,
  })
  markReplied(event)
  if (payload.empty) return true

  if (settings.mode === "voice" && !processed.deliveries.length) {
    const audio = await synthesizeSpeech(stripForSpeech(processed.text), rootConfig).catch(error => {
      hostRuntime.logger?.error?.("[yui-chat] TTS 生成失败", error)
      return null
    })
    if (audio) {
      await sendRecordDelivery(event, audio, response.quoteReply, replyOptions)
      if (record(response.tts).alsoSendText !== true) {
        rememberDeliveredConversation(event, resultValue, source, processed.text, options)
        return true
      }
    }
  }

  if (payload.asImage) {
    const imageFactory = segmentFactory()?.image
    const delivered = await sendReply(event, typeof imageFactory === "function" ? imageFactory(payload.image) : payload.image, response.quoteReply, replyOptions)
    rememberDeliveredConversation(event, resultValue, source, processed.text, options)
    return delivered
  }
  if (payload.chunks) {
    for (const chunk of payload.chunks) await sendReply(event, convertCQCodes(chunk, { removeUnsupported: response.removeCQCode !== false }), response.quoteReply, replyOptions)
    rememberDeliveredConversation(event, resultValue, source, processed.text, options)
    return true
  }

  const segmentation = record(response.segmentation) as SegmentationOptions
  if (segmentation.enabled === true && settings.mode === "text" && isLlmResult(resultValue, source)) {
    const delivered = await sendConfiguredSplitText(event, payload.text, rootConfig, replyOptions)
    rememberDeliveredConversation(event, resultValue, source, processed.text, options)
    return delivered
  }
  const delivered = await sendReply(event, convertCQCodes(payload.text, { removeUnsupported: response.removeCQCode !== false }), response.quoteReply, replyOptions)
  rememberDeliveredConversation(event, resultValue, source, processed.text, options)
  return delivered
}
