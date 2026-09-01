import { configStore, registerConfigPublishHook } from "../../config/store.js"
import { isCommandMessage } from "../message/command-prefixes.js"
import { extractMessageContext } from "../message/message-context.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import type { UnknownRecord } from "../message/types.js"

interface ContextRow {
  messageId: string
  userId: string
  name: string
  text: string
  attachments: { images: number; records: number; videos: number }
  imageUrls: string[]
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

function messageId(event: unknown): string {
  const e = record(event)
  return text(e.message_id || e.messageId || e.id || e.seq)
}

function compact(value: unknown = ""): string {
  return text(value).replace(/\s+/g, " ").trim()
}

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
  const hasMedia = (Array.isArray(e.img) && e.img.length > 0) || segments.some(segment => {
    const source = record(segment)
    const data = record(source.data)
    return ["image", "record", "voice", "audio", "video"].includes(text(source.type || data.type).toLowerCase())
  })
  if (!value && !hasMedia) return false
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
    const settings = contextConfig(config)
    const value = compact(context.text || e.msg || e.raw_message || "").slice(0, Number(settings.maxMessageChars) || 220)
    const imageUrls = [...new Set([
      ...context.images.map(item => item.url),
      ...(Array.isArray(e.img) ? e.img.map(text) : []),
    ].filter(Boolean))]
    if (!value && !imageUrls.length && !context.records.length && !context.videos.length) return false
    const key = scopeKey(e)
    const rows = buffers.get(key) || []
    const row: ContextRow = {
      messageId: messageId(e),
      userId: text(e.user_id), name: userName(e), text: value,
      attachments: { images: imageUrls.length, records: context.records.length, videos: context.videos.length },
      imageUrls,
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
      return `- ${item.name}(${item.userId})：${item.text || "非文本消息"}${suffix}`
    })
    return `最近聊天上下文（只作理解语境，不要逐字复述）：\n${lines.join("\n")}`
  }

  /** 先找当前说话人最近的图片；群聊中找不到时才回退到其他成员。 */
  findRecentImage(event: unknown = {}, options: { maxRowsBack?: number } = {}): RecentImageReference | null {
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
    const find = (sameUser: boolean): RecentImageReference | null => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]
        if (!row || Boolean(row.userId === currentUserId) !== sameUser || !row.imageUrls.length) continue
        const url = row.imageUrls.at(-1)
        if (!url) continue
        return { url, messageId: row.messageId, userId: row.userId, name: row.name, source: sameUser ? "recent-self" : "recent-group", time: row.time }
      }
      return null
    }
    return find(true) || (isGroupEvent(e) ? find(false) : null)
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
