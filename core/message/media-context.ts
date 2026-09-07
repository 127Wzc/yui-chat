import { extractMessageContext, summarizeMessageContext } from "./message-context.js"
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
  status?: "resolved" | "partial" | "unavailable"
}

export interface ResolvedMediaContext {
  text: string
  base: MessageContext
  quote: QuoteContext | null
  attachments: MediaAttachment[]
  diagnostics: string[]
  visionMode?: VisionInputMode
  /** 将引用正文并入当前 user message，避免只停留在系统摘要。 */
  quoteAsCurrent?: boolean
  imageFocus?: "current" | "quote" | "both" | "recent" | "none"
}

export interface ResolveMediaContextOptions {
  /** 将已解析的引用正文作为当前轮用户消息的一部分传给模型。 */
  quoteAsCurrent?: boolean
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
const recentSharedContentPattern = /(?:(?:刚才|刚刚|之前|前面|上一条|上一个|最近).{0,18}(?:发|贴|传|晒|丢|分享).{0,10}(?:什么|啥|内容|东西|怎么样|如何|咋样)|(?:发|贴|传|晒|丢|分享).{0,8}(?:的|那个|这个).{0,10}(?:是什么|是啥|什么内容|怎么样|如何|咋样))/i
const contextualVisualIntentPattern = /(?:评价|点评|锐评|鉴赏|鉴定|打分|吐槽|说说.{0,4}(?:看法|感觉|印象)|讲讲|解释|翻译|辨认|认(?:一下|得出|得|出)|看懂|读懂|好看|怎么样|咋样|如何|是什么|是啥|谁|在干嘛|做什么|什么意思|什么内容)/i
const contextualSubjectPattern = /(?:这|那|它|这个|那个|这张|那张|这幅|那幅|这个东西|那个东西|上面|里面|其中|刚才|刚刚|前面|上一条|上一个)/i
const quotedImageReferencePattern = /(?:(?:看|看看|看下|看一下|瞅|识别|分析|描述|解读|读图|提取文字|评价|点评|锐评|鉴赏|鉴定|打分|吐槽|解释|翻译|辨认).{0,12}(?:这|那|它|这个|那个|这张|那张|这幅|那幅|图|图片|照片|截图|画面|表情包|内容|东西)|(?:这|那|它)(?:个|张|幅)?(?:图|图片|照片|截图|画面|表情包|内容|东西)?.{0,12}(?:怎么|如何|是什么|是啥|什么意思|什么内容|怎么样|咋样|呢|好看))/i
const comparisonVisionIntentPattern = /(?:对比|比较|区别|差别|不同|哪一?张|哪个好|哪个更|两张|几张|一起看)/i
const explicitQuoteTargetPattern = /(?:引用|回复|上面那条|被回复).{0,8}(?:图|图片|照片|截图|画面|内容|这个|那个)?/i
const currentImageTargetPattern = /(?:这次|本次|新发|新传|刚附|刚上传|现在发).{0,8}(?:图|图片|照片|截图)|(?:只看|只分析).{0,8}(?:新图|这张)|(?:别|不要|不用|不看).{0,4}(?:引用|旧图)/i
const onlyQuotedImagePattern = /(?:只看|只分析).{0,8}(?:引用|回复|旧图)|(?:别|不要|不用|不看).{0,4}(?:新图|这次|本次)/i

/** 明确承接机器人刚才的图像解读时，先回到本会话已讨论的图片。 */
export function conversationImageFollowup(prompt: unknown): boolean {
  const value = compact(prompt)
  return !messageManagementIntentPattern.test(value)
    && /第[一二三四五六七八九十\d]+张|(?:左|右)边.{0,8}(?:图|那个|这)|(?:再|继续).{0,5}(?:仔细看|看看|看下|分析|解读)|(?:图里|图中|图上|图片里)|(?:你刚才|你说).{0,12}(?:图|画面|那个|这个)/i.test(value)
    && !recentImageReferencePattern.test(value)
    && !adjacentImageReferencePattern.test(value)
}

export function recentImageRecallMode(media: Partial<ResolvedMediaContext>, prompt: unknown): RecentImageRecallMode {
  if (media.quote || media.attachments?.some(item => item.kind === "image" && item.visionEligible !== false)) return "none"
  return recentImageRecallModeForPrompt(prompt)
}

function contextualVisualIntent(value: string): boolean {
  return contextualVisualIntentPattern.test(value)
    && (contextualSubjectPattern.test(value) || /^(?:请)?(?:帮我)?(?:评价|点评|锐评|鉴赏|鉴定|打分|吐槽|解释|翻译|辨认|说说|讲讲)/i.test(value))
}

function quotedVisualIntent(value: string): boolean {
  return quotedImageReferencePattern.test(value) || contextualVisualIntent(value) || comparisonVisionIntentPattern.test(value)
}

/** 引用媒体默认只提供元数据；只有明确视觉意图才读取，消息管理意图完全禁用视觉输入。 */
export function visionInputModeForPrompt(prompt: unknown): VisionInputMode {
  const value = compact(prompt)
  if (messageManagementIntentPattern.test(value)) return "none"
  if (explicitVisionIntentPattern.test(value) || contextualVisualIntent(value) || comparisonVisionIntentPattern.test(value)) return "all"
  return "current"
}

/** 明确近期指代可查整个短期窗口；省略式“这个”只允许绑定紧邻图片。 */
export function recentImageRecallModeForPrompt(prompt: unknown): RecentImageRecallMode {
  const value = compact(prompt)
  if (messageManagementIntentPattern.test(value)) return "none"
  if (recentImageReferencePattern.test(value) || recentSharedContentPattern.test(value)) return "explicit"
  if (adjacentImageReferencePattern.test(value) || contextualVisualIntent(value)) return "adjacent"
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
  if (typeof message === "object") return [message]
  return [{ type: "text", text: text(message) }]
}

function mediaUrl(value: unknown): string {
  if (typeof value === "string") return value.trim()
  const source = record(value)
  return text(source.url || source.file || source.path || source.src || source.image).trim()
}

function mediaValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(mediaValues)
  if (value === undefined || value === null || value === "") return []
  return [value]
}

function extractTextFromSegments(segments: readonly unknown[] = []): string {
  return segments.map(segment => {
    const source = record(segment)
    const data = segmentData(segment)
    if (source.type === "text" || data.type === "text") return text(data.text || source.text)
    return ""
  }).join("").trim()
}

function normalizedQuotedValue(value: unknown): unknown {
  const source = record(value)
  const data = record(source.data)
  if (
    Object.keys(data).length
    && !source.message && !source.content && !source.segments && !source.raw_message && !source.msg && !source.text && !source.selectedText && !source.img && !source.image && !source.images
    && (data.message || data.content || data.segments || data.raw_message || data.msg || data.text || data.selectedText || data.img || data.image || data.images)
  ) return { ...source, ...data }
  return value
}

function quotedPayload(value: unknown): boolean {
  const source = record(normalizedQuotedValue(value))
  return Boolean(source.message || source.content || source.segments || source.raw_message || source.msg || source.text || source.selectedText || source.img || source.image || source.images)
}

function quotedMediaPayload(value: unknown): boolean {
  const source = record(normalizedQuotedValue(value))
  if (source.img || source.image || source.images) return true
  if (/\[CQ:(?:image|video|record|audio|file),/i.test(text(source.raw_message || source.msg))) return true
  const segments = normalizeMessageSegments(source.message || source.content || source.segments)
  return segments.some(segment => {
    const item = record(segment)
    const data = segmentData(segment)
    return ["image", "video", "record", "voice", "audio", "file"].includes(text(item.type || data.type).toLowerCase())
      || Boolean(data.image || data.images || data.img)
  })
}

function inlineQuotedMessage(event: UnknownRecord): unknown {
  const segments = Array.isArray(event.message) ? event.message : []
  const replySegments = segments
    .map(segment => ({ source: record(segment), data: segmentData(segment) }))
    .filter(item => ["reply", "source"].includes(text(item.source.type || item.data.type).toLowerCase()))
    .map(item => normalizedQuotedValue(item.data))
  const inlineReply = typeof event.reply === "string" && event.reply.trim()
    ? { text: event.reply }
    : event.reply
  const candidates = [event.source, event.quote, event.quotedMessage, event.quoted_message, inlineReply, ...replySegments]
    .map(normalizedQuotedValue)
    .filter(quotedPayload)
  return candidates.find(quotedMediaPayload) || candidates[0] || null
}

function quotedHistory(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.map(normalizedQuotedValue)
  const source = record(value)
  for (const candidate of [source.messages, source.history, source.records, record(source.data).messages, record(source.data).history]) {
    if (Array.isArray(candidate) && candidate.length) return candidate.map(normalizedQuotedValue)
  }
  return [normalizedQuotedValue(value)]
}

async function getQuotedMessage(event: unknown = {}): Promise<unknown> {
  const e = record(event)
  const eventContext = extractMessageContext(e)
  const source = { ...record(e.quoted_message), ...record(e.quotedMessage), ...record(e.quote), ...record(e.reply), ...record(e.source) }
  const sequence = e.reply_id || source.seq || source.id || source.message_id || source.messageId || eventContext.replies[0]?.id
  const inline = inlineQuotedMessage(e)
  if (!sequence && !inline) return null
  const locator = {
    message_id: e.reply_id || source.message_id || source.messageId || source.id || eventContext.replies[0]?.id,
    seq: source.seq,
    user_id: source.user_id,
    sender: source.sender,
  }
  const matches = (value: unknown): boolean => {
    const candidate = record(value)
    if (candidate.group_id && e.group_id && text(candidate.group_id) !== text(e.group_id)) return false
    const id = candidate.message_id || candidate.messageId || candidate.id
    if (candidate.seq && locator.seq) return text(candidate.seq) === text(locator.seq)
    return !(id && locator.message_id) || text(id) === text(locator.message_id)
  }
  const merge = (value: unknown, status = "resolved"): UnknownRecord => {
    const candidate = record(value)
    return {
      ...locator, ...candidate,
      message_id: candidate.message_id || candidate.messageId || candidate.id || locator.message_id,
      seq: candidate.seq || locator.seq,
      user_id: candidate.user_id || locator.user_id,
      sender: { ...record(locator.sender), ...record(candidate.sender) }, quoteStatus: status,
    }
  }
  const diagnostics: string[] = []
  const select = (value: unknown): unknown => {
    const candidates = quotedHistory(value).filter(quotedPayload)
    const candidate = candidates.find(matches)
    if (candidate) return merge(candidate)
    if (candidates.length) diagnostics.push("引用读取结果与目标消息不匹配，未采用其他消息。")
    return null
  }

  // 引用中的图片地址通常是短时签名 URL。触发引用时优先重新读取目标消息，
  // 不能先采用事件里可能已经过期的 source/quote 快照。Yunzai 的原生方法
  // 叫 getMsg，其他适配器可能提供 getMessage；两者都按消息序号/ID读取一次。
  if (sequence) {
    const readers: Array<{ owner: UnknownRecord; name: string; fn: (...args: unknown[]) => unknown }> = []
    const addReader = (ownerValue: unknown, name: string): void => {
      const owner = record(ownerValue)
      const fn = owner[name]
      if (typeof fn !== "function") return
      if (readers.some(reader => reader.owner === owner && reader.name === name && reader.fn === fn)) return
      readers.push({ owner, name, fn: fn as (...args: unknown[]) => unknown })
    }
    addReader(e, "getMessage")
    addReader(e, "getMsg")
    if (e.isGroup) addReader(e.group, "getMessage")
    if (e.isGroup) addReader(e.group, "getMsg")
    if (!e.isGroup) addReader(e.friend, "getMessage")
    if (!e.isGroup) addReader(e.friend, "getMsg")
    addReader(e.bot, "getMessage")
    addReader(e.bot, "getMsg")
    addReader(record(e.bot).adapter, "getMessage")
    addReader(record(e.bot).adapter, "getMsg")

    for (const reader of readers) {
      try {
        // 已绑定到群/好友对象的方法通常只接收消息 ID；未绑定的适配器方法
        // 可能要求目标群号作为第一个参数，按函数形态兼容这两种调用。
        const args = reader.fn.length >= 2 && e.group_id
          ? [e.group_id, sequence]
          : [sequence]
        const value = select(await reader.fn.apply(reader.owner, args))
        if (value) return value
      } catch (error) {
        diagnostics.push(`读取最新引用消息失败（${reader.name}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  try {
    const getReply = e.getReply
    if (typeof getReply === "function" && sequence) {
      const value = select(await (getReply as () => Promise<unknown>).call(event))
      if (value) return value
    }
  } catch (error) {
    diagnostics.push(`读取引用消息失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (sequence) {
    try {
      const owner = e.isGroup ? record(e.group) : record(e.friend)
      const getHistory = owner.getChatHistory
      if (typeof getHistory === "function") {
        const value = select(await (getHistory as (seq: unknown, count: number) => Promise<unknown>).call(owner, sequence, 1))
        if (value) return value
      }
    } catch (error) {
      diagnostics.push(`读取历史消息失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (inline && matches(inline)) return { ...merge(inline, "partial"), diagnostics }
  return { ...merge({}, "unavailable"), diagnostics }
}

function buildQuoteContext(quoteValue: unknown): QuoteContext {
  const quote = record(quoteValue)
  const messageValue = quote.message || quote.content || quote.segments || quote.raw_message || quote.msg || quote.text || quote.selectedText
  const segments = normalizeMessageSegments(messageValue)
  const raw = typeof quote.raw_message === "string"
    ? quote.raw_message
    : typeof messageValue === "string" && /\[CQ:/i.test(messageValue)
      ? messageValue
      : ""
  const message = raw && typeof messageValue === "string" && /\[CQ:/i.test(messageValue) ? [] : segments
  const prompt = typeof quote.msg === "string" && quote.msg
    ? quote.msg
    : typeof quote.text === "string" && quote.text
      ? quote.text
      : typeof quote.selectedText === "string" && quote.selectedText
        ? quote.selectedText
        : raw
  const context = extractMessageContext({ message, raw_message: raw, msg: prompt }, prompt)
  const sender = record(quote.sender)
  const senderId = sender.user_id || quote.user_id
  const senderName = text(sender.card || sender.nickname || quote.senderNickname || quote.nickname || quote.card || quote.user_id)
  const messageId = quote.message_id || quote.messageId || quote.id || quote.seq
  const attachments = attachmentsFromContext(context, "quote", { messageId, sender: { userId: senderId, name: senderName } })
  for (const value of [...mediaValues(quote.img), ...mediaValues(quote.image), ...mediaValues(quote.images)]) {
    const url = mediaUrl(value)
    if (url) pushAttachment(attachments, { kind: "image", url, source: "quote", messageId, sender: { userId: senderId, name: senderName } })
  }
  return {
    text: raw && /\[CQ:/i.test(raw) ? context.text : extractTextFromSegments(segments) || context.text,
    sender: { userId: senderId, name: senderName },
    messageId,
    attachments,
    status: quote.quoteStatus === "unavailable" ? "unavailable" : quote.quoteStatus === "partial" ? "partial" : "resolved",
  }
}

/** 汇总当前消息、引用消息和 @ 用户头像，供模型视觉输入与工具观察复用。 */
export async function resolveMediaContext(event: unknown = {}, prompt: unknown = "", config: unknown = {}, options: ResolveMediaContextOptions = {}): Promise<ResolvedMediaContext> {
  const e = record(event)
  const rootConfig = record(config)
  const mediaRecognition = record(rootConfig.mediaRecognition)
  const base = extractMessageContext(e, prompt)
  const currentMeta = { messageId: e.message_id || e.messageId || e.seq, sender: { userId: e.user_id, name: text(record(e.sender).card || record(e.sender).nickname) } }
  const attachments = attachmentsFromContext(base, "current", currentMeta)
  if (Array.isArray(e.img)) for (const url of e.img) pushAttachment(attachments, { kind: "image", url: text(url), source: "yunzai-img", ...currentMeta })

  // 引用正文和引用媒体是两个独立开关：即使管理员关闭引用媒体，对话仍
  // 应该能看到被引用的文字；关闭时只是不把图片等附件加入模型输入。
  const quotedValue = await getQuotedMessage(e)
  const quote = quotedValue ? buildQuoteContext(quotedValue) : null
  if (quote && mediaRecognition.includeQuotedMedia !== false) {
    for (const attachment of quote.attachments) pushAttachment(attachments, attachment)
  }

  if (!quote && /头像/.test(text(prompt)) && !attachments.some(item => item.kind === "image") && mediaRecognition.useAtAvatar !== false) {
    const bot = record(e.bot)
    const botIds = new Set([text(e.self_id), text(bot.uin)].filter(Boolean))
    const mention = base.mentions.find(item => item.qq && item.qq !== "all" && !botIds.has(item.qq))
    if (mention?.qq) pushAttachment(attachments, { kind: "image", url: avatarUrl(mention.qq), source: "at-avatar", userId: mention.qq })
  }
  const visionMode = visionInputModeForPrompt(prompt)
  const promptValue = compact(prompt)
  const quotedImageUrls = new Set((quote?.attachments || [])
    .filter(item => item.kind === "image")
    .map(item => text(item.url))
    .filter(Boolean))
  const hasQuotedImage = quotedImageUrls.size > 0
  const hasUniqueCurrentImage = attachments.some(item => item.kind === "image" && item.source !== "quote" && !quotedImageUrls.has(text(item.url)))
  const quoteAsCurrent = options.quoteAsCurrent === true
  const quoteTargeted = hasQuotedImage
    && visionMode !== "none"
    && quotedVisualIntent(promptValue)
    && (!hasUniqueCurrentImage || explicitQuoteTargetPattern.test(promptValue))
  const compareImages = comparisonVisionIntentPattern.test(promptValue)
  const currentTargeted = currentImageTargetPattern.test(promptValue) && !compareImages
  const onlyQuote = onlyQuotedImagePattern.test(promptValue)
  const imageFocus = visionMode === "none" ? "none" : currentTargeted ? "current"
    : quoteAsCurrent && quote ? (compareImages && !onlyQuote ? "both" : "quote") : "current"
  for (const attachment of attachments) {
    if (attachment.kind !== "image" || visionMode === "none") {
      attachment.visionEligible = false
      continue
    }
    const isQuote = attachment.source === "quote"
    const duplicatesQuote = !isQuote && quotedImageUrls.has(text(attachment.url))
    attachment.visionEligible = duplicatesQuote || (attachment.source === "yunzai-img" && quote?.status === "unavailable") || (isQuote && mediaRecognition.includeQuotedMedia === false)
      ? false
      : currentTargeted ? !isQuote
      : quoteAsCurrent && quote ? (isQuote || (!onlyQuote && (compareImages || !quoteTargeted)))
      : compareImages
      ? visionMode === "all" && (isQuote || !duplicatesQuote)
      : quoteTargeted
        ? isQuote
        : !isQuote && !duplicatesQuote
  }
  const quoteDiagnostics = record(quotedValue).diagnostics
  const diagnostics = [
    ...(Array.isArray(quoteDiagnostics) ? quoteDiagnostics.map(text) : []),
    ...(attachments.length ? [] : ["本轮没有可解析的媒体附件。"]),
  ]
  if (quoteAsCurrent && quote && !currentTargeted) attachments.sort((a, b) => Number(b.source === "quote") - Number(a.source === "quote"))
  const selectedUrls = new Set<string>()
  for (const attachment of attachments) {
    if (attachment.kind !== "image" || attachment.visionEligible === false) continue
    const url = text(attachment.url)
    if (selectedUrls.has(url)) attachment.visionEligible = false
    else {
      selectedUrls.add(url)
      attachment.imageNumber = selectedUrls.size
    }
  }
  return { text: base.text, base, quote, attachments, diagnostics, visionMode, quoteAsCurrent, imageFocus }
}

export function summarizeMediaContext(media: Partial<ResolvedMediaContext> = {}): string {
  const lines: string[] = []
  const base = media.base || {}
  // 媒体地址统一由下方经过 visionEligible 筛选的 attachments 汇总；这里
  // 只保留 @ 和引用 ID，避免宿主在当前事件里重复附带引用图片时泄漏原 URL。
  const baseSummary = summarizeMessageContext({ ...base, images: [], records: [], videos: [], files: [] })
  if (baseSummary) lines.push(baseSummary)
  if (media.quote?.text && media.quoteAsCurrent !== true) {
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
  const content: Exclude<OpenAiUserContent, string> = []
  const appendText = (value: string): void => { if (value) content.push({ type: "text", text: value }) }
  const quote = media.quote
  if (media.quoteAsCurrent && quote) {
    appendText(`本轮主要对象：${media.imageFocus === "current" ? "用户明确指定的本次新图" : media.imageFocus === "both" ? "引用图片与本次新图的比较" : "引用消息"}。`)
    appendText([
      `引用消息（消息 ID：${text(quote.messageId) || "未知"}，原作者：${quote.sender.name || text(quote.sender.userId) || "未知"}）：`,
      quote.text || (quote.status === "unavailable" ? "引用正文未能读取，请勿用其他消息代替。" : quote.attachments.length ? "（非文本消息）" : "（没有可用正文）"),
      quote.status === "partial" ? "（仅取得引用预览，可能不完整）" : "",
    ].filter(Boolean).join("\n"))
  }
  const seen = new Set<string>()
  if (quote?.attachments.some(item => item.kind === "image") && !(media.attachments || []).some(item => item.source === "quote" && item.visionEligible !== false)) {
    appendText("引用消息含图片，但本轮未提供其图片内容。")
  }
  let imageIndex = 0
  for (const attachment of media.attachments || []) {
    if (attachment.kind !== "image" || attachment.visionEligible === false) continue
    const key = text(attachment.originalUrl || attachment.url || attachment.cacheKey)
    if (seen.has(key)) continue
    seen.add(key)
    imageIndex++
    const sender = record(attachment.sender)
    const source = attachment.source === "quote" ? "引用消息"
      : attachment.source === "recent-self" ? "当前用户之前发送的消息"
      : attachment.source === "recent-group" ? "群成员之前发送的消息"
      : attachment.source === "at-avatar" ? "被提及用户的头像" : "本次新发消息"
    const label = `图片 ${attachment.imageNumber || imageIndex}：${attachment.fromHistory ? "上轮讨论的" : ""}${source}${sender.name || sender.userId ? `，来自 ${text(sender.name || sender.userId)}` : ""}${attachment.messageId ? `，消息 ID：${text(attachment.messageId)}` : ""}`
    const url = text(attachment.preparedUrl)
    const provided = allowVision && /^(?:https?:|data:image\/(?:png|jpeg|jpg|webp|gif);base64,)/i.test(url)
    appendText(`${label}（${provided ? "图片内容紧随其后" : attachment.prepareError ? "图片读取失败" : attachment.limitSkipped ? "超过本轮图片数量限制" : "本轮未提供图片内容"}）。`)
    if (provided) content.push({ type: "image_url", image_url: { url } })
  }
  const unsupported = (media.attachments || []).filter(item => item.kind !== "image")
  if (unsupported.length) appendText("消息另含语音、视频或文件，本轮未解析其内容。")
  appendText(text(value))
  return content.some(part => part.type === "image_url") ? content : content.map(part => part.type === "text" ? part.text : "").join("\n\n")
}
