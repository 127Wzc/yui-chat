import { configStore, registerConfigPublishHook } from "../../config/store.js"
import { isCommandMessage } from "../message/command-prefixes.js"
import { extractMessageContext } from "../message/message-context.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import type { UnknownRecord } from "../message/types.js"

interface ContextRow {
  messageId: string
  userId: string
  name: string
  aliases: string[]
  text: string
  attachments: { images: number; records: number; videos: number }
  imageUrls: string[]
  /** 被动观察阶段只保存一层回复关系；引用媒体仍在真正触发时按 ID 懒读取。 */
  replyTo?: {
    messageId: string
    userId: string
    name: string
    text: string
    images: number
  }
  time: number
}

export interface RecentImageReference {
  url: string
  messageId: string
  userId: string
  name: string
  source: "recent-self" | "recent-group"
  time: number
}

interface RecentImageLookupOptions {
  maxRowsBack?: number
  prompt?: unknown
}

const buffers = new Map<string, ContextRow[]>()

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function scopeKey(event: unknown): string {
  const e = record(event)
  return isGroupEvent(e) ? `group:${groupIdFromEvent(e)}` : `private:${text(e.user_id)}`
}

function userName(event: unknown): string {
  const e = record(event)
  const sender = record(e.sender)
  return text(sender.card || sender.nickname || e.user_id || "User")
}

function userAliases(event: unknown): string[] {
  const e = record(event)
  const sender = record(e.sender)
  return [...new Set([
    sender.card, sender.nickname, sender.name,
    e.card, e.nickname, e.user_name, e.user_id,
  ].map(item => compact(item)).filter(Boolean))]
}

function messageId(event: unknown): string {
  const e = record(event)
  return text(e.message_id || e.messageId || e.id || e.seq)
}

function compact(value: unknown = ""): string {
  return text(value).replace(/\s+/g, " ").trim()
}

function mediaUrl(value: unknown): string {
  if (typeof value === "string") return value.trim()
  const source = record(value)
  return text(source.url || source.file || source.path || source.src || source.image).trim()
}

function messageIdOf(value: unknown): string {
  const source = record(value)
  return text(source.message_id || source.messageId || source.id || source.seq).trim()
}

function replySnapshots(event: UnknownRecord): UnknownRecord[] {
  const segments = Array.isArray(event.message) ? event.message : []
  const replySegments = segments
    .map(segment => {
      const source = record(segment)
      const data = record(source.data)
      return { ...source, ...data }
    })
    .filter(segment => ["reply", "source"].includes(text(segment.type).toLowerCase()))
  return [
    record(event.reply),
    record(event.source),
    record(event.quote),
    record(event.quotedMessage),
    record(event.quoted_message),
    ...replySegments,
  ].filter(item => Object.keys(item).length > 0)
}

function replyContext(event: UnknownRecord, context: ReturnType<typeof extractMessageContext>): { target: ContextRow["replyTo"]; imageUrls: string[] } | null {
  const snapshots = replySnapshots(event)
  const reply = context.replies[0]
  const targetId = text(event.reply_id || event.replyId || reply?.id || snapshots.map(messageIdOf).find(Boolean)).trim()
  if (!targetId) return null
  const snapshot = snapshots.find(item => messageIdOf(item) === targetId)
    || snapshots.find(item => !messageIdOf(item) && (item.message || item.content || item.segments || item.raw_message || item.msg || item.text))
  const sender = record(snapshot?.sender)
  const userId = text(sender.user_id || sender.userId || snapshot?.user_id || snapshot?.userId).trim()
  const name = compact(sender.card || sender.nickname || sender.name || snapshot?.senderNickname || snapshot?.nickname || snapshot?.card)
  const snapshotPrompt = text(snapshot?.selectedText || snapshot?.text || snapshot?.msg).trim()
  const snapshotContext = snapshot
    ? extractMessageContext(snapshot, snapshotPrompt)
    : { text: "", images: [], records: [], videos: [], files: [], mentions: [], replies: [], rawTypes: [] }
  const imageUrls = [...new Set([
    ...snapshotContext.images.map(item => item.url),
    ...[snapshot?.img, snapshot?.image, snapshot?.images].flatMap(value => Array.isArray(value) ? value : value ? [value] : []).map(mediaUrl),
  ].filter(Boolean))]
  const preview = compact(reply?.selectedText || snapshotPrompt || snapshotContext.text)
  return {
    target: {
      messageId: targetId,
      userId,
      name,
      text: preview,
      images: imageUrls.length,
    },
    imageUrls,
  }
}

function referenceText(value: unknown = ""): string {
  return compact(value).toLocaleLowerCase().replace(/[\s@＠,，。.!！?？:：;；、~～_\-]/g, "")
}

function aliasMentioned(prompt: string, alias: string): boolean {
  const normalized = referenceText(alias)
  if (!normalized || normalized.length < 2) return false
  return prompt.includes(normalized)
}

const selfImageReferencePattern = /(?:(?:我|俺|本人).{0,12}(?:发|贴|传|晒|丢|分享)|(?:我|俺)(?:的|那|这).{0,8}(?:张|个|幅|东西|内容)?)/i
const otherImageReferencePattern = /(?:(?:他|她|他们|她们|别人|对方|那个人|那位).{0,12}(?:发|贴|传|晒|丢|分享)|(?:他|她|别人|对方)(?:的|那|这).{0,8}(?:张|个|幅|东西|内容)?)/i

function contextConfig(config: unknown): UnknownRecord {
  return record(record(config).context)
}

function configuredMessageCount(config: unknown): number {
  return Math.max(0, Number(contextConfig(config).recentMessageCount) || 0)
}

function shouldRecord(event: unknown, config: unknown): boolean {
  const e = record(event)
  const context = contextConfig(config)
  if (!configuredMessageCount(config)) return false
  if (isGroupEvent(e) && context.captureGroups === false) return false
  if (!isGroupEvent(e) && context.capturePrivate === false) return false
  const value = compact(e.msg || e.raw_message || "")
  const segments = Array.isArray(e.message) ? e.message : []
  const hasReply = Boolean(e.reply_id || e.replyId) || segments.some(segment => {
    const source = record(segment)
    const data = record(source.data)
    return ["reply", "source"].includes(text(source.type || data.type).toLowerCase())
  })
  const hasMedia = (Array.isArray(e.img) && e.img.length > 0) || segments.some(segment => {
    const source = record(segment)
    const data = record(source.data)
    return ["image", "record", "voice", "audio", "video"].includes(text(source.type || data.type).toLowerCase())
  })
  if (!value && !hasMedia && !hasReply) return false
  if (context.ignoreCommands !== false && isCommandMessage(value, config)) return false
  return true
}

/** 最近消息缓冲只负责短期语境，不承担长期记忆、模型历史或消息持久化。 */
export class RecentContextStore {
  prune(config: unknown = configStore.get()): void {
    const maxMessages = configuredMessageCount(config)
    if (!maxMessages) {
      buffers.clear()
      return
    }
    const context = contextConfig(config)
    const ttlMs = Math.max(60000, Number(context.scopeTtlMs) || 6 * 60 * 60 * 1000)
    const maxScopes = Math.max(10, Number(context.maxScopes) || 1000)
    const now = Date.now()
    for (const [key, rows] of buffers) {
      const fresh = rows.filter(row => now - row.time <= ttlMs)
      if (fresh.length) buffers.set(key, fresh.slice(-maxMessages))
      else buffers.delete(key)
    }
    while (buffers.size > maxScopes) {
      let oldestKey: string | null = null
      let oldest = Infinity
      for (const [key, rows] of buffers) {
        const last = rows.at(-1)?.time || 0
        if (last < oldest) {
          oldest = last
          oldestKey = key
        }
      }
      if (!oldestKey) break
      buffers.delete(oldestKey)
    }
  }

  record(event: unknown = {}): boolean {
    const config = configStore.get()
    this.prune(config)
    if (!shouldRecord(event, config)) return false
    const e = record(event)
    const context = extractMessageContext(e, e.msg || e.raw_message || "")
    const reply = replyContext(e, context)
    const rawText = text(e.msg || e.raw_message || "")
    const replyCodeOnly = context.replies.length > 0 && /\[CQ:(?:reply|source)[,\]]/i.test(rawText)
    const value = compact(context.text || (replyCodeOnly ? "" : rawText))
    // 宿主有时会把引用快照展开到当前事件；能拿到快照地址时先从当前发言的
    // 媒体里扣除，避免把“回复别人的图”记录成发送者自己的图。没有快照时
    // 不做猜测，关系仍保留在 replyTo 中。
    const quotedImageUrls = new Set(reply?.imageUrls || [])
    const imageUrls = [...new Set([
      ...context.images.map(item => item.url),
      ...(Array.isArray(e.img) ? e.img.map(text) : []),
    ].filter(url => Boolean(url) && !quotedImageUrls.has(url)))]
    if (!value && !imageUrls.length && !context.records.length && !context.videos.length && !reply?.target) return false
    const key = scopeKey(e)
    const rows = buffers.get(key) || []
    const row: ContextRow = {
      messageId: messageId(e),
      userId: text(e.user_id), name: userName(e), aliases: userAliases(e), text: value,
      attachments: { images: imageUrls.length, records: context.records.length, videos: context.videos.length },
      imageUrls,
      ...(reply?.target ? { replyTo: reply.target } : {}),
      time: Date.now(),
    }
    const duplicateIndex = row.messageId ? rows.findIndex(item => item.messageId === row.messageId) : -1
    if (duplicateIndex >= 0) rows.splice(duplicateIndex, 1)
    rows.push(row)
    buffers.set(key, rows.slice(-configuredMessageCount(config)))
    return true
  }

  buildPrompt(event: unknown = {}): string {
    const config = configStore.get()
    this.prune(config)
    const limit = configuredMessageCount(config)
    if (!limit) return ""
    const rows = (buffers.get(scopeKey(event)) || []).slice(-limit)
    if (!rows.length) return ""
    const lines = rows.map(item => {
      const attachments: string[] = []
      if (item.attachments.images) attachments.push(`${item.attachments.images}图`)
      if (item.attachments.records) attachments.push(`${item.attachments.records}语音`)
      if (item.attachments.videos) attachments.push(`${item.attachments.videos}视频`)
      const suffix = attachments.length ? ` [${attachments.join(",")}]` : ""
      const reply = item.replyTo
      const replyAuthor = reply?.name || (reply?.userId ? `成员${reply.userId}` : "上一条消息")
      const replyMedia = reply?.images ? `，含${reply.images}张图` : ""
      const replyPreview = reply?.text ? `：“${reply.text}”` : ""
      const relation = reply
        ? ` ↳ 回复${replyAuthor}的消息${replyMedia}${replyPreview}`
        : ""
      return `- ${item.name}(${item.userId})：${item.text || "非文本消息"}${suffix}${relation}`
    })
    return `最近聊天上下文（按顺序；“↳”表示回复对象；只作理解语境，不要逐字复述）：\n${lines.join("\n")}`
  }

  /** 按回复语境、点名对象和人称指代选择最近图片；无明确对象时使用时间上最近的一张。 */
  findRecentImage(event: unknown = {}, options: RecentImageLookupOptions = {}): RecentImageReference | null {
    const config = configStore.get()
    this.prune(config)
    const e = record(event)
    let rows = [...(buffers.get(scopeKey(event)) || [])]
    const currentUserId = text(e.user_id)
    const currentMessageId = messageId(e)
    if (currentMessageId) rows = rows.filter(row => row.messageId !== currentMessageId)
    else {
      const currentText = compact(e.msg || e.raw_message || "")
      const last = rows.at(-1)
      if (last && last.userId === currentUserId && currentText && last.text === currentText) rows = rows.slice(0, -1)
    }
    const maxRowsBack = Number(options.maxRowsBack)
    if (Number.isFinite(maxRowsBack) && maxRowsBack >= 0) {
      const count = Math.floor(maxRowsBack)
      rows = count ? rows.slice(-count) : []
    }

    const imageRows = rows.filter(row => row.imageUrls.length)
    const find = (predicate: (row: ContextRow) => boolean): RecentImageReference | null => {
      for (let index = imageRows.length - 1; index >= 0; index -= 1) {
        const row = imageRows[index]
        if (!row || !predicate(row)) continue
        const url = row.imageUrls.at(-1)
        if (url) return {
          url, messageId: row.messageId, userId: row.userId, name: row.name,
          source: row.userId === currentUserId ? "recent-self" : "recent-group",
          time: row.time,
        }
      }
      return null
    }

    const prompt = referenceText(options.prompt ?? e.msg ?? e.raw_message ?? "")
    const context = extractMessageContext(e, e.msg || e.raw_message || "")
    const bot = record(e.bot)
    const botIds = new Set([text(e.self_id), text(bot.uin)].filter(Boolean))
    const mentionedUserIds = new Set(context.mentions.map(item => item.qq).filter(id => id && id !== "all" && !botIds.has(id)))
    const targetUserIds = new Set(mentionedUserIds)
    let longestAlias = 0
    if (!mentionedUserIds.size) {
      for (const row of rows) {
        for (const alias of Array.isArray(row.aliases) ? row.aliases : [row.name]) {
          const aliasLength = referenceText(alias).length
          if (!aliasMentioned(prompt, alias) || aliasLength < longestAlias) continue
          if (aliasLength > longestAlias) {
            targetUserIds.clear()
            longestAlias = aliasLength
          }
          targetUserIds.add(row.userId)
        }
      }
    }
    // 一旦用户明确点名，即使该对象在短期窗口里没有图片，也不能错误回退到提问者自己的旧图。
    if (targetUserIds.size) return find(row => targetUserIds.has(row.userId))

    const rawPrompt = compact(options.prompt ?? e.msg ?? e.raw_message ?? "")
    if (selfImageReferencePattern.test(rawPrompt)) return find(row => row.userId === currentUserId)
    if (isGroupEvent(e) && otherImageReferencePattern.test(rawPrompt)) return find(row => row.userId !== currentUserId)
    return find(() => true)
  }

  stats(): { scopes: number; messages: number } {
    this.prune()
    let messages = 0
    for (const rows of buffers.values()) messages += rows.length
    return { scopes: buffers.size, messages }
  }

  clear(): void {
    buffers.clear()
  }
}

export const recentContextStore = new RecentContextStore()
registerConfigPublishHook(config => recentContextStore.prune(config))
