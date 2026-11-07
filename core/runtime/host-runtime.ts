import { applyHostActionEntries, type HostCommandEntry, type actionCommandStatus } from "./host-command-registry.js"
import { pathToFileURL } from "node:url"
import path from "node:path"
import type { MessageDestination, OutboundPart, ForwardPart } from "../message-chain/types.js"
import { outboundPartTypes } from "../message-chain/types.js"
import type { MessageAdapter } from "../message-chain/adapter.js"
/** 宿主事件的最小静态边界；具体 Yunzai 字段仍必须在业务边界自行收窄。 */
export interface HostEvent extends Record<string, unknown> {
  msg?: string
  raw_message?: string
  message?: unknown
  at?: unknown
  group_id?: string | number
  user_id?: string | number
  isGroup?: boolean
  reply?: (...args: unknown[]) => unknown | Promise<unknown>
}

/** Yunzai 插件构造参数的最小公共形状。 */
export interface HostPluginOptions extends Record<string, unknown> {
  name?: string
  dsc?: string
  event?: string
  priority?: number
  rule?: Array<Record<string, unknown>>
}

/** 宿主插件实例；业务入口只依赖事件和回复，不依赖 Yunzai 内部实现。 */
export interface HostPluginInstance {
  e: HostEvent
  reply(...args: unknown[]): unknown | Promise<unknown>
}

/** Yunzai 插件构造器的最小公共形状。 */
export interface HostPluginConstructor {
  new (options: HostPluginOptions): HostPluginInstance
}

export interface HostQuotedMessageSelection<T> {
  value: T | null
  diagnostics?: string[]
}

export interface HostQuotedMessageResult<T> {
  value: T | null
  diagnostics: string[]
}

export type HostQuotedMessageSelector<T> = (value: unknown) => HostQuotedMessageSelection<T>

export interface HostRuntime {
  registerInboundMessages(root: string): void
  inboundMessage(event: unknown): InboundMessage | undefined
  isMasterUser(botId: string, userId: string): Promise<boolean>
  applyActionEntries(root: string, entries: HostCommandEntry[]): Promise<typeof actionCommandStatus>
  readonly bot?: YuiChatHostBot
  readonly logger?: YuiChatHostLogger
  readonly segment?: YuiChatHostSegmentFactory
  readonly Plugin: HostPluginConstructor
  canSendMessage(event: unknown): boolean
  requireMessageDestination(destination: MessageDestination, event?: unknown): Promise<void>
  sendMessage(event: unknown, payload: unknown, quote?: boolean, options?: HostRecord, destination?: MessageDestination): Promise<unknown>
  messageEvent(fields: HostRecord, destination: MessageDestination): HostRecord
  observeMessageSends(event: HostRecord, onSent: () => void): HostRecord
  supportsMessagePart(type: string): boolean
  messageSegment(part: OutboundPart, value?: unknown, adapter?: { at?: (id: string) => unknown }): unknown
  makeForwardMessage(part: ForwardPart, payloads: readonly unknown[][], event: unknown, destination?: MessageDestination): Promise<unknown>
  readQuotedMessage<T>(event: unknown, sequence: unknown, select: HostQuotedMessageSelector<T>): Promise<HostQuotedMessageResult<T>>
}

type HostRecord = Record<string, unknown>
interface InboundMessage { userId: string; botId: string; groupId: string; messageId: string; text: string }
const inboundMessages = new WeakMap<object, InboundMessage>()
const messageDestinations = new WeakMap<object, MessageDestination>()
const observedEvents = new WeakMap<object, HostRecord>()
let hostRoot = ""
let ingressRegistered = false
function registerInboundMessages(root: string): void {
  hostRoot = root
  const bot = hostRuntime.bot
  if (ingressRegistered || typeof bot?.prependListener !== "function") return
  const listener = (event: unknown): void => {
    const value = record(event)
    if (!value.user_id || !value.self_id || !value.message_id) return
    const text = Array.isArray(value.message) ? value.message.filter(part => record(part).type === "text").map(part => String(record(part).text || "")).join("") : String(value.raw_message || value.msg || "")
    inboundMessages.set(value, Object.freeze({ userId: String(value.user_id), botId: String(value.self_id), groupId: String(value.group_id || ""), messageId: String(value.message_id), text }))
  }
  ;(bot.prependListener as (name: string, fn: (event: unknown) => void) => unknown).call(bot, "message", listener)
  ingressRegistered = true
}
async function isMasterUser(botId: string, userId: string): Promise<boolean> {
  if (!hostRoot) return false
  try {
    const module = await import(pathToFileURL(path.join(hostRoot, "lib/config/config.js")).href) as { default?: HostRecord }
    const master = record(module.default?.master)
    return Array.isArray(master[botId]) && (master[botId] as unknown[]).map(String).includes(userId)
  } catch { return false /* Missing host identity authority fails closed. */ }
}

function record(value: unknown): HostRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as HostRecord : {}
}

function canSendMessage(event: unknown): boolean {
  const e = record(event)
  return messageDestinations.has(e) || typeof e.reply === "function"
}

async function destinationOwner(destination: MessageDestination, event: unknown = {}): Promise<HostRecord> {
  if (!["group", "user"].includes(destination.type)) throw new Error("未知消息投递目标类型。")
  if (typeof destination.id !== "string" || !destination.id.trim()) throw new Error("缺少消息投递目标。")
  const root = record(hostRuntime.bot)
  const bot = destination.accountId !== undefined ? record(root[destination.accountId]) : record(record(event).bot || hostRuntime.bot)
  const methods = destination.type === "group" ? ["pickGroup"] : ["pickUser", "pickFriend"]
  for (const method of methods) {
    const picker = bot[method]
    if (typeof picker !== "function") continue
    const owner = record(await picker.call(bot, Number(destination.id), true))
    if (typeof owner.sendMsg === "function") return owner
  }
  throw new Error(`无法获取${destination.type === "group" ? "群" : "用户"} ${destination.id}。`)
}

async function sendMessage(event: unknown, payload: unknown, quote?: boolean, options?: HostRecord, destination?: MessageDestination): Promise<unknown> {
  const e = record(event)
  const target = destination || messageDestinations.get(e)
  if (target) {
    const owner = await destinationOwner(target, e)
    return (owner.sendMsg as (payload: unknown) => unknown).call(owner, payload)
  }
  if (typeof e.reply !== "function") throw new Error("当前事件不支持消息投递。")
  return e.reply.call(event, payload, quote, options)
}

function messageSegment(part: OutboundPart, value: unknown = "", adapter?: { at?: (id: string) => unknown }): unknown {
  const factory = hostRuntime.segment
  const media = typeof value === "string" ? value.replace(/^data:[^;,]+;base64,/i, "base64://") : value
  switch (part.type) {
    case "text": return part.text
    case "mention": {
      const at = adapter || factory
      const generated = at?.at?.(part.userId)
      return generated && typeof generated === "object" && !Array.isArray(generated) ? generated : { type: "at", qq: part.userId }
    }
    case "reply": return typeof factory?.reply === "function" ? factory.reply(part.messageId) : `[CQ:reply,id=${part.messageId}]`
    case "dice": return typeof factory?.dice === "function" ? factory.dice() : `骰子：${Math.ceil(Math.random() * 6)}`
    case "rps": return typeof factory?.rps === "function" ? factory.rps(part.value) : `猜拳：${["石头", "剪刀", "布"][part.value - 1]}`
    case "music": {
      const data = part.platform === "custom" ? {
        type: "custom",
        ...(part.url ? { url: part.url } : {}),
        ...(part.audio ? { audio: part.audio } : {}),
        ...(part.title ? { title: part.title } : {}),
        ...(part.image ? { image: part.image } : {}),
        ...(part.singer ? { singer: part.singer } : {}),
      } : { type: part.platform, id: String(part.id || "") }
      return { type: "music", data }
    }
    case "image":
    case "audio":
    case "video":
    case "file": {
      const name = part.type === "audio" ? "record" : part.type
      const create = factory?.[name]
      if (typeof create !== "function") throw new Error(`宿主未提供${{ image: "图片", audio: "语音", video: "视频", file: "文件" }[part.type]}消息段能力。`)
      return create.call(factory, media)
    }
    case "forward": throw new Error("合并转发必须通过节点投递边界处理。")
  }
}

/** 宿主显式失败不能登记为已发送；没有消息 ID 本身不代表失败。 */
export function hostMessageFailed(receipt: unknown): boolean {
  const source = record(receipt)
  const error = source.error
  return receipt === false || source.success === false || ["failed", "error"].includes(String(source.status))
    || Boolean(error && (!Array.isArray(error) || error.length))
}

/** 只提取宿主成功回执中的真实消息 ID；数组不能拼成一个平台不存在的 ID。 */
export function hostMessageIds(receipt: unknown): string[] {
  const ids = new Set<string>()
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) { value.slice(0, 100).forEach(item => visit(item, depth + 1)); return }
    const source = record(value)
    if (source.status === "failed" || source.status === "error" || source.success === false
      || source.error && (!Array.isArray(source.error) || source.error.length)) return
    const raw = source.message_id ?? source.messageId ?? source.id
    for (const id of Array.isArray(raw) ? raw : [raw]) {
      if (typeof id === "string" && id.trim() || typeof id === "number" && Number.isFinite(id) && id !== 0) ids.add(String(id).trim())
    }
    visit(source.data, depth + 1)
  }
  visit(receipt, 0)
  return [...ids]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 将不同 Yunzai 适配器的引用读取入口收敛为单一宿主契约。
 * 业务模块只负责校验、归一化候选消息，不感知宿主方法名与参数差异。
 */
async function readQuotedMessage<T>(event: unknown, sequence: unknown, select: HostQuotedMessageSelector<T>): Promise<HostQuotedMessageResult<T>> {
  const e = record(event)
  const diagnostics: string[] = []
  const accept = (value: unknown): T | null => {
    const selected = select(value)
    if (selected.diagnostics?.length) diagnostics.push(...selected.diagnostics)
    return selected.value
  }
  const readers: Array<{ owner: HostRecord; name: string; fn: (...args: unknown[]) => unknown }> = []
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
      const value = accept(await reader.fn.apply(reader.owner, args))
      if (value) return { value, diagnostics }
    } catch (error) {
      diagnostics.push(`读取最新引用消息失败（${reader.name}）：${errorMessage(error)}`)
    }
  }

  try {
    const getReply = e.getReply
    if (typeof getReply === "function") {
      const value = accept(await (getReply as () => Promise<unknown>).call(event))
      if (value) return { value, diagnostics }
    }
  } catch (error) {
    diagnostics.push(`读取引用消息失败：${errorMessage(error)}`)
  }

  try {
    const owner = e.isGroup ? record(e.group) : record(e.friend)
    const getHistory = owner.getChatHistory
    if (typeof getHistory === "function") {
      const value = accept(await (getHistory as (seq: unknown, count: number) => Promise<unknown>).call(owner, sequence, 1))
      if (value) return { value, diagnostics }
    }
  } catch (error) {
    diagnostics.push(`读取历史消息失败：${errorMessage(error)}`)
  }

  return { value: null, diagnostics }
}

/** 宿主适配层：领域模块通过这里读取 Yunzai 全局对象，避免新增直接全局引用。 */
export const hostRuntime: HostRuntime = Object.freeze({
  registerInboundMessages,
  isMasterUser,
  inboundMessage(event: unknown) {
    const value = record(event)
    const original = inboundMessages.get(observedEvents.get(value) || value)
    return original && String(value.user_id) === original.userId && String(value.self_id) === original.botId && String(value.message_id) === original.messageId ? original : undefined
  },
  applyActionEntries: applyHostActionEntries,
  canSendMessage,
  async requireMessageDestination(destination: MessageDestination, event?: unknown) { await destinationOwner(destination, event) },
  sendMessage,
  messageSegment,
  async makeForwardMessage(part: ForwardPart, payloads: readonly unknown[][], event: unknown, destination?: MessageDestination) {
    const e = record(event)
    const target = destination || messageDestinations.get(e)
    const root = record(hostRuntime.bot)
    const bot = target?.accountId !== undefined ? record(root[target.accountId]) : record(e.bot || hostRuntime.bot)
    const senderId = target?.accountId !== undefined ? bot.uin : e.self_id || bot.uin
    const defaultUserId = String(senderId || "").trim() || "80000000"
    const nodes = part.nodes.flatMap((node, index) => {
      const content = payloads[index]
      if (!content?.length) return []
      return [{
        message: content.length === 1 ? content[0] : content,
        nickname: String(node.nickname || "").trim() || "网络搜索来源",
        user_id: String(node.userId || "").trim() || defaultUserId,
        ...(Number.isFinite(Number(node.time)) ? { time: Number(node.time) } : {}),
      }]
    })
    if (!nodes.length) throw new Error("合并转发中没有可发送的节点。")
    const scope = target ? await destinationOwner(target, e) : e.isGroup ? record(e.group) : record(e.friend)
    if (typeof scope.makeForwardMsg === "function") return scope.makeForwardMsg.call(scope, nodes)
    if (typeof bot.makeForwardMsg === "function") return bot.makeForwardMsg.call(bot, nodes)
    return { type: "node", data: nodes }
  },
  supportsMessagePart(type: string) {
    return typeof hostRuntime.segment?.[type === "audio" ? "record" : type] === "function"
  },
  messageEvent(fields: HostRecord, destination: MessageDestination) {
    const event = { ...fields }
    messageDestinations.set(event, { ...destination })
    return event
  },
  observeMessageSends(event: HostRecord, onSent: () => void) {
    if (!canSendMessage(event)) return event
    const observed = { ...event, async reply(payload: unknown, quote?: boolean, options?: HostRecord) {
      const result = await sendMessage(event, payload, quote, options)
      if (!hostMessageFailed(result)) onSent()
      return result
    } }
    observedEvents.set(observed, observedEvents.get(event) || event)
    return observed
  },
  get bot() {
    return globalThis.Bot
  },
  get logger() {
    return globalThis.logger
  },
  get segment() {
    return globalThis.segment
  },
  get Plugin(): HostPluginConstructor {
    return globalThis.plugin as HostPluginConstructor
  },
  readQuotedMessage,
})

/** 当前唯一的发送实现。保留宿主入口，投递器只依赖 MessageAdapter 契约。 */
export const yunzaiMessageAdapter: MessageAdapter = {
  id: "yunzai",
  supports(type) {
    if (["image", "audio", "video", "file"].includes(type)) return hostRuntime.supportsMessagePart(type)
    return outboundPartTypes.includes(type)
  },
  canSend(context) {
    return Boolean(context.destination) || canSendMessage(context.e)
  },
  async prepare(part, context, resolveResource) {
    if (!this.supports(part.type)) throw new Error(`当前适配器不支持 ${part.type} 消息。`)
    if (part.type === "forward") {
      const payloads: unknown[][] = []
      for (const node of part.nodes) {
        const items: unknown[] = []
        for (const [index, nodePart] of node.parts.entries()) {
          const spaced = nodePart.type === "text" && node.parts[index - 1]?.type === "mention" && !/^\s/.test(nodePart.text)
            ? { ...nodePart, text: ` ${nodePart.text}` } : nodePart
          items.push((await this.prepare(spaced, context, resolveResource)).payload)
        }
        payloads.push(items)
      }
      return { payload: await hostRuntime.makeForwardMessage(part, payloads, context.e, context.destination), standalone: true, allowQuote: false }
    }
    const value = "source" in part ? await resolveResource(part.source) : ""
    return {
      payload: messageSegment(part, value),
      standalone: ["audio", "video", "music"].includes(part.type),
      allowQuote: context.quoteStandalone === true || !["audio", "music"].includes(part.type),
    }
  },
  async send(payload, context) {
    const receipt = await sendMessage(context.e, payload, context.quote, context.replyOptions, context.destination)
    if (hostMessageFailed(receipt)) throw new Error("宿主消息投递失败。")
    return { receipt, messageIds: hostMessageIds(receipt) }
  },
}
