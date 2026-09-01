import { renderChatCard, renderTextCard } from "../rendering/render-service.js"
import { checkAccess } from "./access-control.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { hasCQAtCode, stripUnsupportedCQCodes } from "../message/cq-code.js"
import type { UnknownRecord } from "../message/types.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"

interface PreflightResult {
  ok: boolean
  message?: string
  silent?: boolean
  lockKey?: string
}

export interface ReplyPayload {
  text: string
  asImage: boolean
  empty?: boolean
  image?: unknown
  chunks?: string[]
}

const buckets = new Map<string, number[]>()
const locks = new Map<string, number>()

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function includesAny(value: unknown, words: unknown): boolean {
  const input = text(value)
  return (Array.isArray(words) ? words : []).some(word => Boolean(word) && input.includes(text(word)))
}

function keyFor(event: unknown): string {
  const e = record(event)
  return isGroupEvent(e) ? `${groupIdFromEvent(e)}:${text(e.user_id)}` : `private:${text(e.user_id)}`
}

export function normalizeResponseText(value: unknown = ""): string {
  const trimmed = text(value).trim()
  if (!trimmed || trimmed === "```" || trimmed === "<EMPTY>") return ""
  return trimmed.replace(/^<EMPTY>|<EMPTY>$/g, "").trim()
}

export function isEmptyResponse(value: unknown = ""): boolean {
  return normalizeResponseText(value) === ""
}

/** 对话入口的第一道门：权限、关键词、限流和并发锁全部在模型调用前完成。 */
export async function preflight(event: unknown, prompt: unknown, config: unknown): Promise<PreflightResult> {
  const e = record(event)
  const root = record(config)
  const chat = record(root.chat)
  const response = record(root.response)
  const access = checkAccess(e, root)
  if (!access.ok) return { ok: false, message: access.reason || "当前不允许对话。", silent: access.silent !== false }
  if (includesAny(prompt, response.promptBlockWords)) return { ok: false, message: `${text(record(root.persona).firstPerson)}不想回答这个问题。` }
  const rate = record(chat.rateLimit)
  if (rate.enabled && !(rate.masterBypass && e.isMaster === true)) {
    const key = keyFor(e)
    const now = Date.now()
    const windowMs = Math.max(1, Number(rate.windowSeconds) || 900) * 1000
    const bucket = (buckets.get(key) || []).filter(item => now - item < windowMs)
    if (bucket.length >= (Number(rate.maxRequests) || 20)) {
      buckets.set(key, bucket)
      return { ok: false, message: "对话太频繁了，稍后再试。" }
    }
    bucket.push(now)
    buckets.set(key, bucket)
  }
  if (chat.concurrent === false) {
    const key = keyFor(e)
    pruneLocks(root)
    if (locks.has(key)) return { ok: false, message: "上一轮对话还没结束，请稍等。" }
    locks.set(key, Date.now())
    return { ok: true, lockKey: key }
  }
  return { ok: true }
}

export function releasePreflight(state: unknown): void {
  const lockKey = record(state).lockKey
  if (lockKey) locks.delete(text(lockKey))
}

function pruneLocks(config: unknown = {}): void {
  const chat = record(record(config).chat)
  const ttlMs = Math.max(10000, Number(chat.lockTimeoutMs) || 120000)
  const now = Date.now()
  for (const [key, startedAt] of locks) if (now - startedAt > ttlMs) locks.delete(key)
}

export function clearResponseState(): { rateLimitBuckets: number; locks: number } {
  const stats = { rateLimitBuckets: buckets.size, locks: locks.size }
  buckets.clear()
  locks.clear()
  return stats
}

export function responseStateStats(): { rateLimitBuckets: number; locks: number } {
  pruneLocks()
  return { rateLimitBuckets: buckets.size, locks: locks.size }
}

export async function sendConfirm(event: unknown, config: unknown): Promise<void> {
  const e = record(event)
  const root = record(config)
  const response = record(root.response)
  const persona = record(root.persona)
  const type = Number(response.replyConfirmType)
  if (!type) return
  try {
    const reply = e.reply
    if (type === -1 && typeof reply === "function") await (reply as (value: unknown, quote?: unknown) => Promise<unknown>).call(event, `${text(persona.firstPerson)}在哦`, true)
    else if (record(e.group).setEmojiLike && e.message_id) await (record(e.group).setEmojiLike as (messageId: unknown, type: number) => Promise<unknown>).call(e.group, e.message_id, type)
    else if (record(record(e.bot).adapter).setEmojiLike && e.message_id) await (record(record(e.bot).adapter).setEmojiLike as (event: unknown, messageId: unknown, type: number) => Promise<unknown>).call(record(e.bot).adapter, event, e.message_id, type)
  } catch (error) {
    hostRuntime.logger?.debug?.("[yui-chat] 回复确认失败", error)
  }
}

function eventSender(event: unknown): { userId: string; name: string } {
  const e = record(event)
  const sender = record(e.sender)
  return { userId: text(e.user_id || sender.user_id || "unknown"), name: text(sender.card || sender.nickname || sender.user_id || e.user_id || "User") }
}

function eventScope(event: unknown): { type: "group" | "private"; groupId: string; groupName: string } {
  const e = record(event)
  const group = record(e.group)
  const isGroup = isGroupEvent(e)
  return { type: isGroup ? "group" : "private", groupId: isGroup ? groupIdFromEvent(e) : "", groupName: text(e.group_name || group.name) }
}

async function textToImage(value: string, config: unknown, options: UnknownRecord = {}): Promise<unknown> {
  const root = record(config)
  const response = record(root.response)
  const persona = record(root.persona)
  const render = record(response.render)
  const event = options.e
  if (render.chatCardAsImage !== false) {
    try {
      const result = await renderChatCard({
        prompt: text(record(options.result).prompt || options.prompt), answer: value, sender: eventSender(event), scope: eventScope(event),
        quote: record(options.result).media && record(record(options.result).media).quote,
        media: record(options.result).media,
        metadata: { channel: record(options.result).channel, adapter: record(options.result).adapter, toolRounds: record(options.result).toolRounds, source: options.source || record(options.result).source },
        steps: record(options.result).steps,
      }, root)
      return record(result).buffer
    } catch (error) {
      hostRuntime.logger?.warn?.("[yui-chat] 富聊天卡片渲染失败，回退文本卡片", error)
    }
  }
  const result = await renderTextCard({ title: text(record(persona).assistantLabel || "Yui Chat"), subtitle: "自动转图回复", content: value, footer: "Yui Chat · Auto Render" }, root)
  return record(result).buffer
}

/** 构建最终回复载荷；这里不发送消息，只决定文本、图片或分块形态。 */
export async function buildReplyPayload(value: unknown, config: unknown, options: UnknownRecord = {}): Promise<ReplyPayload> {
  const root = record(config)
  const response = record(root.response)
  const persona = record(root.persona)
  let output = normalizeResponseText(value)
  if (!output) return { text: "", asImage: false, empty: true }
  if (response.removeCQCode) output = stripUnsupportedCQCodes(output)
  output = normalizeResponseText(output)
  if (!output) return { text: "", asImage: false, empty: true }
  if (includesAny(output, response.blockWords)) return { text: `${text(persona.firstPerson)}不想回答这个问题QAQ`, asImage: false }
  const hasCQAt = hasCQAtCode(output)
  const render = record(response.render)
  if (!hasCQAt && (options.forceImage === true || (response.autoUsePicture && output.length >= Number(response.autoUsePictureThreshold || 1200))) && render.enabled !== false) {
    return { image: await textToImage(output, root, options), text: output, asImage: true }
  }
  const max = Number(response.maxTextChunkLength) || 1800
  if (!hasCQAt && output.length > max) return { chunks: output.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) || [output], text: output, asImage: false }
  return { text: output, asImage: false }
}
