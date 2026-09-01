import { buildOpenAiUserContent, extractMessageContext, summarizeMessageContext } from "./message-context.js"
import type { MessageContext, MessageMediaItem, UnknownRecord, OpenAiUserContent } from "./types.js"

type MediaKind = "image" | "video" | "audio" | "file"

export interface MediaAttachment extends UnknownRecord {
  kind: MediaKind
  url?: string
  text?: string
  source?: string
  visionEligible?: boolean
}

export interface QuoteContext {
  text: string
  sender: { userId: unknown; name: string }
  messageId: unknown
  attachments: MediaAttachment[]
}

export interface ResolvedMediaContext {
  text: string
  base: MessageContext
  quote: QuoteContext | null
  attachments: MediaAttachment[]
  diagnostics: string[]
  visionMode?: VisionInputMode
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function compact(value: unknown = ""): string {
  return text(value).replace(/\s+/g, " ").trim()
}

type VisionInputMode = "none" | "current" | "all"
export type RecentImageRecallMode = "none" | "explicit" | "adjacent"

const messageManagementIntentPattern = /(?:撤回|删除).{0,8}(?:消息|这条|该条|引用|回复)|(?:设为|设置|标记为|取消|移除).{0,6}精华|(?:撤回|取消精华|移除精华)/i
const explicitVisionIntentPattern = /(?:看图|看看|看一下|看下|识图|识别|分析|描述|解读|读图|提取文字|ocr|图片|图中|图里|图内|图上|照片|截图|画面|表情包|二维码|这是什么|这是啥|这个是谁|这是谁|什么意思)/i
const recentImageReferencePattern = /(?:(?:刚才|刚刚|刚发|之前|前面|上一张|上张|上一个|最近).{0,16}(?:图|图片|照片|截图|画面|表情包)|(?:图|图片|照片|截图|画面|表情包).{0,16}(?:刚才|刚刚|刚发|之前|前面|上一张|上张|上一个|最近)|(?:再)?(?:看|看看|识别|分析|描述|解读).{0,12}(?:刚才|刚刚|刚发|之前|前面|上一张|上一个|那个))/i
const adjacentImageReferencePattern = /(?:(?:看|看看|看下|看一下|瞅|识别|分析|描述|解读).{0,8}(?:这|那)(?:个|张)?(?:图|图片|照片|截图|画面|表情包)?|(?:这|那)(?:个|张)?(?:图|图片|照片|截图|画面|表情包)|(?:那)?这(?:个|张)?呢|那(?:个|张)呢|(?:这|那)(?:是什么|是啥))/i

/** 引用媒体默认只提供元数据；只有明确视觉意图才读取，消息管理意图完全禁用视觉输入。 */
export function visionInputModeForPrompt(prompt: unknown): VisionInputMode {
  const value = compact(prompt)
  if (messageManagementIntentPattern.test(value)) return "none"
  if (explicitVisionIntentPattern.test(value)) return "all"
  return "current"
}

/** 明确近期指代可查整个短期窗口；省略式“这个”只允许绑定紧邻图片。 */
export function recentImageRecallModeForPrompt(prompt: unknown): RecentImageRecallMode {
  const value = compact(prompt)
  if (messageManagementIntentPattern.test(value)) return "none"
  if (recentImageReferencePattern.test(value)) return "explicit"
  if (adjacentImageReferencePattern.test(value)) return "adjacent"
  return "none"
}

function segmentData(segment: unknown): UnknownRecord {
  const source = record(segment)
  return Boolean(source.data) && typeof source.data === "object" && !Array.isArray(source.data) ? source.data as UnknownRecord : source
}

function pushAttachment(list: MediaAttachment[], attachment: MediaAttachment): void {
  if (!attachment.url && !attachment.text) return
  const key = `${attachment.kind}:${attachment.url || attachment.text}:${attachment.source || ""}`
  if (!list.some(item => `${item.kind}:${item.url || item.text}:${item.source || ""}` === key)) list.push(attachment)
}

function avatarUrl(qq: unknown): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(text(qq))}&s=640`
}

function attachmentsFromContext(context: MessageContext, source = "current", meta: UnknownRecord = {}): MediaAttachment[] {
  const attachments: MediaAttachment[] = []
  for (const item of context.images) pushAttachment(attachments, { kind: "image", url: item.url, source, ...meta })
  for (const item of context.videos) pushAttachment(attachments, { kind: "video", url: item.url, source, ...meta })
  for (const item of context.records) pushAttachment(attachments, { kind: "audio", url: item.url, source, ...meta })
  for (const item of context.files) pushAttachment(attachments, { kind: "file", url: item.url, source, ...meta })
  return attachments
}

function pushContextAttachment(context: MessageContext, item: MediaAttachment): void {
  if (!item.url) return
  const base: MessageMediaItem = { type: item.kind, url: item.url, source: item.source || "media", ...item }
  if (item.kind === "image" && !context.images.some(existing => existing.url === item.url)) context.images.push(base)
  else if (item.kind === "video" && !context.videos.some(existing => existing.url === item.url)) context.videos.push(base)
  else if (item.kind === "audio" && !context.records.some(existing => existing.url === item.url)) context.records.push({ ...base, type: "record" })
  else if (item.kind === "file" && !context.files.some(existing => existing.url === item.url)) context.files.push(base)
}

function normalizeMessageSegments(message: unknown): unknown[] {
  if (Array.isArray(message)) return message
  if (!message) return []
  return [{ type: "text", text: text(message) }]
}

function extractTextFromSegments(segments: readonly unknown[] = []): string {
  return compact(segments.map(segment => {
    const source = record(segment)
    const data = segmentData(segment)
    if (source.type === "text" || data.type === "text") return text(data.text || source.text)
    return ""
  }).join(" "))
}

async function getQuotedMessage(event: unknown = {}): Promise<unknown> {
  const e = record(event)
  try {
    const getReply = e.getReply
    if (typeof getReply === "function" && (e.reply_id || e.source)) return await (getReply as () => Promise<unknown>).call(event)
  } catch (error) {
    return { diagnostics: [`读取引用消息失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  const source = record(e.source)
  const sequence = source.seq || source.id || source.message_id
  if (!sequence) return null
  try {
    const owner = e.isGroup ? record(e.group) : record(e.friend)
    const getHistory = owner.getChatHistory
    if (typeof getHistory !== "function") return null
    const history = await (getHistory as (seq: unknown, count: number) => Promise<unknown>).call(owner, sequence, 1)
    return Array.isArray(history) ? history[0] : history
  } catch (error) {
    return { diagnostics: [`读取历史消息失败：${error instanceof Error ? error.message : String(error)}`] }
  }
}

function buildQuoteContext(quoteValue: unknown): QuoteContext {
  const quote = record(quoteValue)
  const segments = normalizeMessageSegments(quote.message || quote.raw_message || quote.msg)
  const raw = typeof quote.raw_message === "string" ? quote.raw_message : ""
  const context = extractMessageContext({ message: segments, raw_message: raw, msg: quote.msg || "" }, quote.msg || "")
  const sender = record(quote.sender)
  const senderId = sender.user_id || quote.user_id
  const senderName = text(sender.card || sender.nickname || quote.senderNickname || quote.user_id)
  const messageId = quote.message_id || quote.messageId || quote.id || quote.seq
  return {
    text: extractTextFromSegments(segments) || context.text,
    sender: { userId: senderId, name: senderName },
    messageId,
    attachments: attachmentsFromContext(context, "quote", { messageId, sender: { userId: senderId, name: senderName } }),
  }
}

/** 汇总当前消息、引用消息和 @ 用户头像，供模型视觉输入与工具观察复用。 */
export async function resolveMediaContext(event: unknown = {}, prompt: unknown = "", config: unknown = {}): Promise<ResolvedMediaContext> {
  const e = record(event)
  const rootConfig = record(config)
  const mediaRecognition = record(rootConfig.mediaRecognition)
  const base = extractMessageContext(e, prompt)
  const attachments = attachmentsFromContext(base, "current")
  if (Array.isArray(e.img)) for (const url of e.img) pushAttachment(attachments, { kind: "image", url: text(url), source: "yunzai-img" })

  const quotedValue = mediaRecognition.includeQuotedMedia === false ? null : await getQuotedMessage(e)
  const quote = quotedValue && !record(quotedValue).diagnostics ? buildQuoteContext(quotedValue) : null
  if (quote) for (const attachment of quote.attachments) pushAttachment(attachments, attachment)

  if (!attachments.some(item => item.kind === "image") && mediaRecognition.useAtAvatar !== false) {
    const bot = record(e.bot)
    const botIds = new Set([text(e.self_id), text(bot.uin)].filter(Boolean))
    const mention = base.mentions.find(item => item.qq && item.qq !== "all" && !botIds.has(item.qq))
    if (mention?.qq) pushAttachment(attachments, { kind: "image", url: avatarUrl(mention.qq), source: "at-avatar", userId: mention.qq })
  }
  let visionMode = visionInputModeForPrompt(prompt)
  if (
    visionMode === "current"
    && attachments.some(item => item.kind === "image" && item.source === "quote")
    && adjacentImageReferencePattern.test(compact(prompt))
  ) visionMode = "all"
  for (const attachment of attachments) {
    attachment.visionEligible = attachment.kind === "image"
      && visionMode !== "none"
      && (visionMode === "all" || attachment.source !== "quote")
  }
  const quoteDiagnostics = record(quotedValue).diagnostics
  const diagnostics = [
    ...(Array.isArray(quoteDiagnostics) ? quoteDiagnostics.map(text) : []),
    ...(attachments.length ? [] : ["本轮没有可解析的媒体附件。"]),
  ]
  return { text: base.text, base, quote, attachments, diagnostics, visionMode }
}

export function summarizeMediaContext(media: Partial<ResolvedMediaContext> = {}): string {
  const lines: string[] = []
  const base = media.base || {}
  // 媒体地址统一由下方经过 visionEligible 筛选的 attachments 汇总；这里
  // 只保留 @ 和引用 ID，避免宿主在当前事件里重复附带引用图片时泄漏原 URL。
  const baseSummary = summarizeMessageContext({ ...base, images: [], records: [], videos: [], files: [] })
  if (baseSummary) lines.push(baseSummary)
  if (media.quote?.text) {
    const sender = media.quote.sender?.name || media.quote.sender?.userId || "unknown"
    lines.push(`引用消息 ${media.quote.messageId || ""} 来自 ${sender}：${media.quote.text}`)
  }
  const grouped: Partial<Record<MediaKind, MediaAttachment[]>> = {}
  for (const item of media.attachments || []) (grouped[item.kind] ||= []).push(item)
  for (const [kind, items] of Object.entries(grouped)) {
    if (!items) continue
    const readable = items.filter(item => item.visionEligible !== false)
    const skipped = items.length - readable.length
    if (readable.length) lines.push(`${kind} 附件 ${readable.length} 个：${readable.map(item => `${displayAttachment(item)}(${item.source || "current"})`).join("，")}`)
    if (skipped) lines.push(`${kind} 附件 ${skipped} 个（本轮无需读取）`)
  }
  for (const item of media.diagnostics || []) lines.push(item)
  return lines.join("\n")
}

function displayAttachment(item: MediaAttachment): string {
  const value = text(item.originalUrl || item.url || item.text || "unknown")
  if (/^data:/i.test(value)) return `${value.match(/^data:([^;,]+)/i)?.[1] || "data"} data-url${item.size ? `, ${item.size} bytes` : ""}`
  if (/^file:/i.test(value) || /^\/[^/]/.test(value) || /^[a-z]:[\\/]/i.test(value)) return "local-file-hidden"
  return value
}

export function mediaToMessageContext(media: Partial<ResolvedMediaContext> = {}): MessageContext {
  const base = media.base || { chain: [], text: "", images: [], records: [], videos: [], files: [], mentions: [], replies: [], rawTypes: [] }
  const context: MessageContext = {
    chain: [...(base.chain || [])],
    text: media.text || base.text || "",
    // 图片只能从媒体预处理后的 preparedUrl 进入模型，不能回退到宿主原始 URL。
    images: [], records: [...(base.records || [])], videos: [...(base.videos || [])], files: [...(base.files || [])],
    mentions: [...(base.mentions || [])], replies: [...(base.replies || [])], rawTypes: [...(base.rawTypes || [])],
  }
  for (const attachment of media.attachments || []) {
    if (attachment.kind === "image") {
      const preparedUrl = text(attachment.preparedUrl)
      if (attachment.visionEligible !== false && preparedUrl) pushContextAttachment(context, { ...attachment, url: preparedUrl })
    } else pushContextAttachment(context, attachment)
  }
  return context
}

export function buildMediaUserContent(value: unknown, media: Partial<ResolvedMediaContext> = {}, allowVision = false): OpenAiUserContent {
  return buildOpenAiUserContent(value, mediaToMessageContext(media), allowVision)
}
