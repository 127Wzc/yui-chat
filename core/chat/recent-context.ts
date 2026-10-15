import { estimateTokens } from "./token-budget.js"
import { configStore, registerConfigPublishHook } from "../../config/store.js"
import { isCommandMessage } from "../message/command-prefixes.js"
import { stripMessageCodes, extractMessageContext } from "../message/message-context.js"
import { groupIdFromEvent, isGroupEvent } from "../message/event-scope.js"
import { hostRuntime, hostMessageIds } from "../runtime/host-runtime.js"
import { readRecentMessageImages } from "../message/media-context.js"
import type { UnknownRecord } from "../message/types.js"

interface ContextRow {
  messageId: string
  userId: string
  name: string
  aliases: string[]
  text: string
  attachments: { images: number; records: number; videos: number }
  imageUrls: string[]
  mentions?: string[]
  /** 被动观察阶段只保存一层回复关系；引用媒体仍在真正触发时按 ID 懒读取。 */
  replyTo?: {
    messageId: string
    userId: string
    name: string
    text: string
    images: number
  }
  respondingToUserId?: string
  time: number
}

export interface RecentImageReference {
  imageIndex?: number
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
const hydratedScopes = new Set<string>()
const hydrationInFlight = new Map<string, Promise<void>>()

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

function historyRows(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[]
  const source = record(value)
  for (const key of ["messages", "history", "data", "records"]) {
    if (Array.isArray(source[key])) return source[key].filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[]
  }
  return []
}

function historyTime(value: UnknownRecord): number {
  const raw = Number(value.time || value.timestamp || 0)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
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
      hydratedScopes.clear()
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
    return this.recordInScope(event, event)
  }

  /** 会话归属与消息作者独立，助手私聊回复仍属于原请求者。 */
  private recordInScope(event: unknown, scopeEvent: unknown): boolean {
    const config = configStore.get()
    this.prune(config)
    if (!shouldRecord(event, config)) return false
    const e = record(event)
    const context = extractMessageContext(e, e.msg || e.raw_message || "")
    const reply = replyContext(e, context)
    const rawText = text(e.msg || e.raw_message || "")
    const replyCodeOnly = context.replies.length > 0 && /\[CQ:(?:reply|source)[,\]]/i.test(rawText)
    const value = compact(context.text || (replyCodeOnly ? "" : stripMessageCodes(rawText)))
    // 宿主有时会把引用快照展开到当前事件；能拿到快照地址时先从当前发言的
    // 媒体里扣除，避免把“回复别人的图”记录成发送者自己的图。没有快照时
    // 不做猜测，关系仍保留在 replyTo 中。
    const quotedImageUrls = new Set(reply?.imageUrls || [])
    const imageUrls = [...new Set([
      ...context.images.map(item => item.url),
      ...(Array.isArray(e.img) ? e.img.map(text) : []),
    ].filter(url => Boolean(url) && !quotedImageUrls.has(url)))]
    if (!value && !imageUrls.length && !context.records.length && !context.videos.length && !reply?.target) return false
    const key = scopeKey(scopeEvent)
    const rows = buffers.get(key) || []
    const row: ContextRow = {
      messageId: messageId(e),
      userId: text(e.user_id), name: userName(e), aliases: userAliases(e), text: value,
      attachments: { images: imageUrls.length, records: context.records.length, videos: context.videos.length },
      imageUrls,
      mentions: context.mentions.map(item => item.qq),
      ...(reply?.target ? { replyTo: reply.target } : {}),
      time: historyTime(e) ? (historyTime(e) < 1e12 ? historyTime(e) * 1000 : historyTime(e)) : Date.now(),
    }
    if (text(e.user_id) === text(e.self_id) && e.self_id && reply?.target) {
      const targetId = reply.target.userId || rows.find(item => item.messageId === reply.target?.messageId)?.userId
      if (targetId) row.respondingToUserId = targetId
    }
    const duplicateIndex = row.messageId ? rows.findIndex(item => item.messageId === row.messageId) : -1
    if (duplicateIndex >= 0) {
      row.time = rows[duplicateIndex].time
      row.replyTo ||= rows[duplicateIndex].replyTo
      row.respondingToUserId ||= rows[duplicateIndex].respondingToUserId
      if (!row.imageUrls.length) row.imageUrls = rows[duplicateIndex].imageUrls
      row.attachments.images = row.imageUrls.length
      rows[duplicateIndex] = row
    } else rows.push(row)
    rows.sort((a, b) => a.time - b.time)
    buffers.set(key, rows.slice(-configuredMessageCount(config)))
    return true
  }

  /** 只记录已送达的助手回答，并保留实际请求者；不推断其他机器人发言的对象。 */
  recordAssistant(event: unknown, answer: unknown, receipt: unknown = {}): void {
    const e = record(event)
    const value = text(answer).trim()
    if (!value || value === "<EMPTY>" || !e.self_id) return
    const replyId = messageId(e)
    const sentIds = hostMessageIds(receipt)
    const sentId = sentIds.length === 1 ? sentIds[0] : ""
    const syntheticId = sentId || `assistant:${replyId || Date.now()}:${text(e.user_id)}`
    if (!this.recordInScope({ ...e, user_id: e.self_id, sender: { nickname: "助手" }, message_id: syntheticId,
      time: Date.now(), msg: value, raw_message: value, message: [{ type: "text", text: value }], img: [],
      source: undefined, quoted_message: undefined, quotedMessage: undefined, quote: undefined,
      reply: { message_id: replyId, user_id: e.user_id, sender: e.sender }, reply_id: undefined }, e)) return
    const row = (buffers.get(scopeKey(e)) || []).find(item => item.messageId === syntheticId)
    if (row) row.respondingToUserId = text(e.user_id)
  }

  /** 投递成功后登记真实图片消息；资源由平台按消息 ID 懒读取，不保留内联图片或任意本地路径。 */
  async recordDeliveredImages(event: unknown, receipt: unknown, count: number): Promise<void> {
    const e = record(event)
    const ids = hostMessageIds(receipt)
    if (!e.self_id || count <= 0 || receipt === false) return
    if (!ids.length) {
      hostRuntime.logger?.debug?.("[yui-chat] 图片回看登记跳过：宿主回执未提供有效消息 ID。")
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const config = configStore.get()
      const context = contextConfig(config)
      if (!configuredMessageCount(config) || (isGroupEvent(e) ? context.captureGroups === false : context.capturePrivate === false)) return
      const persona = record(record(config).persona)
      // 回看只是辅助记录：多回执核验共用一秒预算，不能拖住已成功的投递。
      const deadline = Date.now() + 1000
      for (const id of ids.slice(0, 8)) {
        let imageCount = count
        if (ids.length > 1) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) break
          const images = await Promise.race([
            readRecentMessageImages(e, { messageId: id, userId: text(e.self_id) }),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining) }),
          ])
          clearTimeout(timer)
          if (images === null) {
            hostRuntime.logger?.debug?.("[yui-chat] 图片回看登记超时，跳过剩余回执。")
            break
          }
          imageCount = images.length
        }
        if (!imageCount) continue
        this.recordInScope({ ...e, user_id: e.self_id, sender: { nickname: text(persona.firstPerson) || "助手" },
          message_id: id, time: Date.now(), msg: "", raw_message: "", img: [],
          source: undefined, quoted_message: undefined, quotedMessage: undefined, quote: undefined, reply_id: undefined, replyId: undefined,
          message: Array.from({ length: imageCount }, (_, index) => ({ type: "image", url: `platform-image:${id}:${index}` })),
          reply: { message_id: messageId(e), user_id: e.user_id, sender: e.sender } }, e)
      }
    } catch {
      // 登记失败不改变真实投递结果，也不记录可能包含媒体凭证的宿主错误。
      hostRuntime.logger?.debug?.("[yui-chat] 图片回看登记失败，已发送消息不受影响。")
    } finally {
      clearTimeout(timer)
    }
  }

  /** 点名只绑定当前窗口中可证实的身份；同名多用户保留歧义。 */
  referencedUsers(event: unknown, prompt: unknown): string[] {
    const e = record(event)
    const rows = buffers.get(scopeKey(e)) || []
    const context = extractMessageContext(e, text(prompt))
    const botIds = new Set([text(e.self_id), text(record(e.bot).uin)].filter(Boolean))
    const ids = new Set(context.mentions.map(item => item.qq).filter(id => id && id !== "all" && !botIds.has(id)))
    if (ids.size) return [...ids]
    const matched = rows.flatMap(row => row.aliases.filter(alias => aliasMentioned(referenceText(prompt), alias)).map(alias => ({ id: row.userId, alias: referenceText(alias) })))
    for (const item of matched) {
      if (botIds.has(item.id) || matched.some(other => other.alias.length > item.alias.length && other.alias.includes(item.alias))) continue
      ids.add(item.id)
    }
    return [...ids]
  }

  /** 每轮提供群窗口；点名/引用仅影响预算优先级，按回复链整组裁剪。 */
  buildReference(event: unknown, prompt: unknown, options: { history?: unknown[]; maxTokens?: number; diagnostics?: UnknownRecord } = {}): string {
    const e = record(event)
    const config = configStore.get()
    this.prune(config)
    if (!isGroupEvent(e) || !configuredMessageCount(config) || contextConfig(config).captureGroups === false) return ""
    const history = (options.history || []).map(record)
    const represented = new Set(history.map(item => text(record(item.metadata).messageId)).filter(Boolean))
    const currentId = messageId(e)
    const targetIds = this.referencedUsers(event, prompt)
    const targets = new Set(targetIds)
    const quoteIds = new Set(extractMessageContext(e).replies.map(item => item.id))
    const rows = (buffers.get(scopeKey(e)) || []).filter(row => (!currentId || row.messageId !== currentId)
      && (row.attachments.images > 0 || !represented.has(row.messageId)
        && !(row.respondingToUserId === text(e.user_id) && history.some(item => item.role === "assistant" && text(item.content) === row.text))))
    const selectedIds = new Set(rows.filter(row => targets.has(row.userId) || targets.has(row.respondingToUserId || "") || quoteIds.has(row.messageId)).map(row => row.messageId))
    const candidates = rows.map((row, index) => ({
      index,
      priority: selectedIds.has(row.messageId) || selectedIds.has(row.replyTo?.messageId || "") ? 1 : 0,
      value: {
        messageId: row.messageId, from: row.userId,
        ...(row.text ? { text: row.text } : {}),
        ...(row.attachments.images ? { images: row.attachments.images } : {}),
        ...(row.attachments.records ? { audio: row.attachments.records } : {}),
        ...(row.attachments.videos ? { videos: row.attachments.videos } : {}),
        ...(row.mentions?.length ? { mentions: row.mentions } : {}),
        ...(row.replyTo ? { replyTo: row.replyTo.messageId,
          ...(!rows.some(other => other.messageId === row.replyTo?.messageId) && !represented.has(row.replyTo.messageId) && row.replyTo.text
            ? { quote: { from: row.replyTo.userId, text: stripMessageCodes(row.replyTo.text) } } : {}) } : {}),
        ...(row.respondingToUserId && !rows.some(other => other.messageId === row.replyTo?.messageId)
          ? { to: row.respondingToUserId } : {}),
      },
    }))
    // 以回复链为单位保留问答；预算不足时整组省略，不能只留下“是的”等孤立回答。
    const byId = new Map(rows.filter(row => row.messageId).map(row => [row.messageId, row]))
    const groups = new Map<string, typeof candidates>()
    for (const item of candidates) {
      let root = rows[item.index]
      const visited = new Set<string>()
      while (root.replyTo?.messageId && byId.has(root.replyTo.messageId) && !visited.has(root.replyTo.messageId)) {
        visited.add(root.messageId)
        root = byId.get(root.replyTo.messageId)!
      }
      const key = root.messageId || `row:${item.index}`
      const group = groups.get(key) || []
      group.push(item); groups.set(key, group)
    }
    const kept: typeof candidates = []
    const maxTokens = Math.max(0, options.maxTokens ?? 1200)
    const serialize = (items: typeof candidates): string => {
      const ordered = [...items].sort((a, b) => a.index - b.index)
      // 观察和投递回调可能乱序；有真实回复关系时先呈现父消息，不猜测其他顺序。
      const result: typeof candidates = []
      const visited = new Set<number>()
      const visit = (item: typeof candidates[number]): void => {
        if (visited.has(item.index)) return
        visited.add(item.index)
        const parent = ordered.find(other => other.value.messageId === item.value.replyTo)
        if (parent) visit(parent)
        result.push(item)
      }
      ordered.forEach(visit)
      const members = Object.fromEntries([...new Set(result.map(item => item.value.from))]
        .sort().map(id => [id, rows.find(row => row.userId === id)?.name || id]))
      return JSON.stringify({ members, ...(targetIds.length ? { requestedUserIds: targetIds } : {}),
        ...(items.length < rows.length ? { incomplete: true } : {}),
        ...(!items.length ? { unavailable: "群窗口没有可提供的消息，不能猜测缺失内容。" } : {}),
        messages: result.map(item => item.value) })
    }
    const ranked = [...groups.values()]
      .sort((a, b) => Math.max(...b.map(item => item.priority)) - Math.max(...a.map(item => item.priority)) || b.at(-1)!.index - a.at(-1)!.index)
    for (const group of ranked) {
      if (estimateTokens(serialize([...kept, ...group])) > maxTokens) continue
      kept.push(...group)
    }
    if (options.diagnostics) Object.assign(options.diagnostics, {
      windowMessages: (buffers.get(scopeKey(e)) || []).length, eligibleMessages: rows.length,
      windowImageMessages: (buffers.get(scopeKey(e)) || []).filter(row => row.attachments.images > 0).length,
      includedImageMessages: kept.filter(item => Boolean(item.value.images)).length,
      includedMessages: kept.length, omittedMessages: rows.length - kept.length,
      ...(rows.length > kept.length ? { omissionReason: "参考资料超出本轮预算，按完整回复链裁剪。" } : {}),
    })
    return serialize(kept)
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

  /** 首次实际群聊对话前补入宿主可提供的最近历史；后续仍只使用进程内短期缓冲。 */
  async buildPromptWithHistory(event: unknown = {}): Promise<string> {
    const config = configStore.get()
    this.prune(config)
    const limit = configuredMessageCount(config)
    if (!limit || !isGroupEvent(event) || contextConfig(config).captureGroups === false) return this.buildPrompt(event)

    const key = scopeKey(event)
    if (!hydratedScopes.has(key)) {
      const pending = hydrationInFlight.get(key) || this.hydrateGroupHistory(event, limit, key)
      hydrationInFlight.set(key, pending)
      await pending
    }
    return this.buildPrompt(event)
  }

  private async hydrateGroupHistory(event: unknown, limit: number, key: string): Promise<void> {
    try {
      const e = record(event)
      const groupId = groupIdFromEvent(e)
      if (!groupId) return
      const eventGroup = record(e.group)
      let owner = eventGroup
      let getChatHistory = owner.getChatHistory
      if (typeof getChatHistory !== "function") {
        const eventBot = record(e.bot)
        const bot = typeof eventBot.pickGroup === "function" ? e.bot : hostRuntime.bot
        const pickGroup = record(bot).pickGroup
        if (typeof pickGroup !== "function") return
        owner = record(await (pickGroup as (...args: unknown[]) => Promise<unknown> | unknown).call(bot, groupId, true))
        getChatHistory = owner.getChatHistory
      }
      if (typeof getChatHistory !== "function") return

      const response = await (getChatHistory as (...args: unknown[]) => Promise<unknown> | unknown).call(owner, 0, limit)
      const rows = historyRows(response)
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const left = historyTime(a.row)
          const right = historyTime(b.row)
          if (left && right && left !== right) return left - right
          return a.index - b.index
        })
      for (const { row } of rows) {
        const sender = record(row.sender)
        const sourceText = row.msg || row.raw_message || row.text || ""
        const rowText = extractMessageContext(row, sourceText).text || text(sourceText)
        this.record({
          ...row,
          self_id: e.self_id,
          isGroup: true,
          isPrivate: false,
          message_type: "group",
          group_id: groupId,
          user_id: row.user_id || row.userId || sender.user_id || sender.userId,
          message_id: row.message_id || row.messageId || row.id || row.seq,
          msg: row.msg || row.raw_message || rowText,
        })
      }
    } catch {
      hostRuntime.logger?.debug?.("[yui-chat] 群聊短期上下文历史读取失败，继续使用当前消息")
    } finally {
      hydratedScopes.add(key)
      hydrationInFlight.delete(key)
    }
  }

  selectRecentImages(event: unknown, prompt: unknown, maxImages = 4): { images: RecentImageReference[]; diagnostic: string } {
    this.prune()
    const e = record(event)
    const value = compact(prompt)
    const targets = this.referencedUsers(e, prompt)
    const personaNames = record(record(configStore.get()).persona)
    const namedAssistant = [personaNames.firstPerson, personaNames.assistantLabel, ...(Array.isArray(personaNames.aliases) ? personaNames.aliases : [])]
      .map(text).filter(Boolean).some(name => {
        const index = value.indexOf(name)
        return index >= 0 && /^(?:刚才|刚刚|刚|之前|最近|最新)?(?:发|贴|传|分享)(?:的|了)/.test(value.slice(index + name.length))
      })
    const assistantTarget = namedAssistant || /(?:你|您)(?:刚才|刚刚|刚|之前|最近|最新)?(?:发|贴|传|分享)(?:的|了)|(?:你|您)的(?:图|照片|截图|表情)/.test(value)
    if (assistantTarget && e.self_id) targets.push(text(e.self_id))
    if (!targets.length && selfImageReferencePattern.test(value)) targets.push(text(e.user_id))
    const rows = (buffers.get(scopeKey(e)) || []).filter(row => !messageId(e) || row.messageId !== messageId(e))
    const comparison = /比较|对比|区别|一起看/.test(value)
    const mentions = extractMessageContext(e, value).mentions.filter(item => item.qq !== text(e.self_id) && item.qq !== "all")
    const aliases = new Map<string, Set<string>>()
    if (!mentions.length) for (const row of rows) for (const alias of row.aliases) {
      if (!aliasMentioned(referenceText(value), alias)) continue
      const key = referenceText(alias)
      const ids = aliases.get(key) || new Set<string>()
      ids.add(row.userId); aliases.set(key, ids)
    }
    const ambiguous = [...aliases].some(([alias, ids]) => ids.size > 1 && ![...aliases.keys()].some(other => other.length > alias.length && other.includes(alias)))
    if (ambiguous || targets.length > 1 && !comparison) return { images: [], diagnostic: "图片对象不唯一，请用户用真实 @ 或明确引用指定成员和图片。" }
    let authorPhrase = value
    const persona = record(record(configStore.get()).persona)
    for (const name of [persona.firstPerson, ...(Array.isArray(persona.aliases) ? persona.aliases : [])].map(text).filter(Boolean)) {
      if (authorPhrase.startsWith(name)) authorPhrase = authorPhrase.slice(name.length).trim()
    }
    authorPhrase = authorPhrase.replace(/^(?:(?:请|帮我|再|看看|看一下|看下|看|识别|分析|描述|解读)\s*)+/, "")
    const namedAuthor = (authorPhrase.match(/^(.*?)(?:发|贴|传|晒|分享)(?:的|了)/)?.[1] || "").replace(/(?:刚才|刚刚|之前|最近|最新|刚)$/, "").trim()
    const explicitOther = Boolean(namedAuthor) || /(?:看|识别|分析|描述|解读|比较|对比).{0,30}(?:发的|的)(?:图片|图|照片|截图|表情包)/.test(value)
    if (!targets.length && otherImageReferencePattern.test(value)) return { images: [], diagnostic: "尚未确认他/她指哪位成员，请 @ 成员或引用原图。" }
    if (!targets.length && explicitOther && !selfImageReferencePattern.test(value)) return { images: [], diagnostic: "未在当前群窗口确认被点名的图片作者，请用户 @ 成员或引用原图。" }
    if (comparison && /我(?:的|发)|和我|与我/.test(value) && !targets.includes(text(e.user_id))) targets.push(text(e.user_id))
    if (!targets.length) {
      const image = this.findRecentImage(e, { prompt })
      return { images: image ? [image] : [], diagnostic: image ? "" : "当前群窗口没有可用的目标图片，请引用原图。" }
    }
    const selected: RecentImageReference[] = []
    const plural = /几张|多张|这些|所有|全部/.test(value)
    let omitted = false
    for (const [targetIndex, id] of targets.entries()) {
      const owned = rows.filter(row => row.userId === id && row.imageUrls.length)
      const chosen = plural ? owned.slice(-maxImages).reverse() : owned.slice(-1)
      if (!chosen.length) return { images: [], diagnostic: "被点名成员在当前群窗口没有可用图片，请引用原图；不能采用其他成员的图片。" }
      const quota = comparison ? Math.max(1, Math.floor(maxImages / targets.length) + (targetIndex < maxImages % targets.length ? 1 : 0)) : maxImages
      let count = 0
      for (const row of chosen) for (const url of row.imageUrls) {
        if (count >= quota) { omitted = true; continue }
        count++
        selected.push({ url, imageIndex: row.imageUrls.indexOf(url), messageId: row.messageId, userId: row.userId, name: row.name, source: row.userId === text(e.user_id) ? "recent-self" : "recent-group", time: row.time })
      }
    }
    const images = selected.slice(0, maxImages)
    if (!comparison) images.sort((a, b) => rows.findIndex(row => row.messageId === a.messageId) - rows.findIndex(row => row.messageId === b.messageId) || (a.imageIndex || 0) - (b.imageIndex || 0))
    return { images, diagnostic: omitted || selected.length > maxImages ? `本轮只提供最近的 ${images.length} 张目标图片，其余未加载。` : "" }
  }

  selectAdjacentImages(event: unknown): { images: RecentImageReference[]; diagnostic: string } {
    const e = record(event)
    this.prune()
    const rows = (buffers.get(scopeKey(e)) || []).filter(row => row.messageId !== messageId(e)).slice(-5)
    const recent = rows.filter(row => Date.now() - row.time <= 2 * 60 * 1000)
    const imageRows = recent.filter(row => row.imageUrls.length)
    const last = recent.at(-1)
    const target = last?.imageUrls.length ? last : imageRows.length === 1 && imageRows[0].userId === text(e.user_id) ? imageRows[0] : null
    if (!target) return { images: [], diagnostic: imageRows.length ? "图片指代不唯一，请引用目标图片。" : "附近没有可确认的图片，请引用或重发原图。" }
    return { images: target.imageUrls.slice(0, 4).map((url, imageIndex) => ({ url, imageIndex,
      messageId: target.messageId, userId: target.userId, name: target.name, time: target.time,
      source: target.userId === text(e.user_id) ? "recent-self" : "recent-group" })), diagnostic: "" }
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
          url, imageIndex: row.imageUrls.length - 1, messageId: row.messageId, userId: row.userId, name: row.name,
          source: row.userId === currentUserId ? "recent-self" : "recent-group",
          time: row.time,
        }
      }
      return null
    }

    const targetUserIds = new Set(this.referencedUsers(e, options.prompt ?? e.msg ?? e.raw_message ?? ""))
    // 同名或同时点名多个人，单图接口不任意选择其中一人。
    if (targetUserIds.size > 1) return null
    if (targetUserIds.size) return find(row => targetUserIds.has(row.userId))

    const rawPrompt = compact(options.prompt ?? e.msg ?? e.raw_message ?? "")
    if (selfImageReferencePattern.test(rawPrompt)) return find(row => row.userId === currentUserId)
    if (isGroupEvent(e) && otherImageReferencePattern.test(rawPrompt)) return null
    return find(() => true)
  }

  stats(): { scopes: number; messages: number } {
    this.prune()
    let messages = 0
    for (const rows of buffers.values()) messages += rows.length
    return { scopes: buffers.size, messages }
  }

  /** 返回当前会话短期窗口中最新一条消息的时间，供空闲触发器判断沉默时长。 */
  latestMessageAt(event: unknown = {}): number {
    this.prune()
    return buffers.get(scopeKey(event))?.at(-1)?.time || 0
  }

  clear(): void {
    buffers.clear()
    hydratedScopes.clear()
    hydrationInFlight.clear()
  }
}

export const recentContextStore = new RecentContextStore()
registerConfigPublishHook(config => recentContextStore.prune(config))
