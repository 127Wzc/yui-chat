import crypto from "node:crypto"
import path from "node:path"
import { configStore, tempDir } from "../../config/store.js"
import { assertSafeHttpUrl, linkSafetyConfig } from "../network/link-safety-policy.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { createNativeAtSegment } from "../message/cq-code.js"
import type {
  ContentPart,
  DeliveryReceipt,
  ForwardNodePart,
  ForwardPart,
  MessageChain,
  MusicPart,
  OutboundPart,
  ResourceRef,
  PartDeliveryReceipt,
} from "./types.js"

type UnknownRecord = Record<string, unknown>

export interface MessageChainDeliveryContext {
  e?: UnknownRecord
  config?: UnknownRecord
  quote?: boolean
  operationId?: string
}

interface ResolvedSender {
  label: string
  send: (payload: unknown, quote?: boolean) => Promise<unknown> | unknown
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function deliveryConfig(config: unknown): {
  quoteReply: boolean
  allowTargetSend: boolean
  allowFilePathImages: boolean
} {
  const root = record(config)
  const delivery = record(record(record(root.response).render).delivery)
  return {
    quoteReply: delivery.quoteReply !== false,
    allowTargetSend: delivery.allowTargetSend === true,
    allowFilePathImages: delivery.allowFilePathImages === true,
  }
}

function isWithin(base: string, candidate: string): boolean {
  const root = path.resolve(base)
  const resolved = path.resolve(candidate)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

/**
 * 解析本地媒体路径。
 *
 * `cache` 是运行时自己产出的中间文件（比如下载好的视频），只要仍在插件
 * 媒体缓存目录内就允许发送；`file` 是模型/用户给出的任意路径，额外需要
 * 显式开启 allowFilePathImages。两者都不能逃出各自的允许目录。
 */
function safeLocalPath(value: string, config: unknown, kind: ResourceRef["kind"]): string {
  const file = value.replace(/^file:\/\//i, "")
  const resolved = path.resolve(file)
  if (kind === "cache") {
    if (!isWithin(tempDir, resolved)) throw new Error("缓存媒体只能来自插件的缓存目录。")
    return resolved
  }
  if (!deliveryConfig(config).allowFilePathImages) throw new Error("本地媒体路径未被允许发送。")
  if (!isWithin(tempDir, resolved)) throw new Error("本地媒体只能来自插件临时缓存目录。")
  return resolved
}

async function resourceValue(source: ResourceRef, config: unknown): Promise<string> {
  const value = text(source.value).trim()
  if (!value) throw new Error("媒体资源为空。")
  if (source.kind === "url") {
    return assertSafeHttpUrl(value, { allowPrivateHosts: linkSafetyConfig(config).allowPrivateHosts })
  }
  if (source.kind === "file" || source.kind === "cache") return safeLocalPath(value, config, source.kind)
  if (source.kind === "base64") {
    const data = source.inlineData || value.replace(/^base64:\/\//i, "")
    if (/^data:/i.test(data)) return data
    return `data:${source.mimeType || "application/octet-stream"};base64,${data}`
  }
  return value
}

/** 按 OneBot music 段结构输出；平台歌曲用 id，自定义卡片用 url/audio。 */
function musicSegment(part: MusicPart): unknown {
  const data = part.platform === "custom"
    ? {
        type: "custom",
        ...(part.url ? { url: part.url } : {}),
        ...(part.audio ? { audio: part.audio } : {}),
        ...(part.title ? { title: part.title } : {}),
        ...(part.image ? { image: part.image } : {}),
        ...(part.singer ? { singer: part.singer } : {}),
      }
    : { type: part.platform, id: text(part.id) }
  return { type: "music", data }
}

function segmentFor(part: OutboundPart, value: string): unknown {
  const factory = hostRuntime.segment
  switch (part.type) {
    case "text": return part.text
    case "mention": return createNativeAtSegment(part.userId, factory)
    case "reply": return typeof factory?.reply === "function" ? factory.reply(part.messageId) : `[CQ:reply,id=${part.messageId}]`
    case "music": return musicSegment(part)
    case "forward": throw new Error("合并转发必须通过节点投递边界处理。")
    case "image":
      if (typeof factory?.image !== "function") throw new Error("宿主未提供图片消息段能力。")
      return factory.image(value)
    case "audio":
      if (typeof factory?.record !== "function") throw new Error("宿主未提供语音消息段能力。")
      return factory.record(value)
    case "video":
      if (typeof factory?.video !== "function") throw new Error("宿主未提供视频消息段能力。")
      return factory.video(value)
    case "file":
      if (typeof factory?.file !== "function") throw new Error("宿主未提供文件消息段能力。")
      return factory.file(value)
    default: throw new Error("消息链片段不支持直接投递。")
  }
}

async function payloadsForParts(parts: readonly ForwardNodePart[], config: unknown): Promise<unknown[]> {
  const payloads: unknown[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    const value = "source" in part ? await resourceValue(part.source, config) : ""
    if (part.type === "text" && parts[index - 1]?.type === "mention" && !/^\s/.test(part.text)) payloads.push(` ${part.text}`)
    else payloads.push(segmentFor(part, value))
  }
  return payloads
}

async function forwardSegment(part: ForwardPart, context: MessageChainDeliveryContext, config: unknown): Promise<unknown> {
  const event = record(context.e)
  const defaultUserId = text(event.self_id || record(hostRuntime.bot).uin).trim() || "80000000"
  const nodes = [] as UnknownRecord[]
  for (const node of part.nodes) {
    const payloads = await payloadsForParts(node.parts, config)
    if (!payloads.length) continue
    nodes.push({
      message: payloads.length === 1 ? payloads[0] : payloads,
      nickname: text(node.nickname).trim() || "网络搜索来源",
      user_id: text(node.userId).trim() || defaultUserId,
      ...(Number.isFinite(Number(node.time)) ? { time: Number(node.time) } : {}),
    })
  }
  if (!nodes.length) throw new Error("合并转发中没有可发送的节点。")
  const scope = event.isGroup ? record(event.group) : record(event.friend)
  const scopeMaker = scope.makeForwardMsg
  if (typeof scopeMaker === "function") return await scopeMaker.call(scope, nodes)
  const bot = record(hostRuntime.bot)
  const botMaker = bot.makeForwardMsg
  if (typeof botMaker === "function") return await botMaker.call(hostRuntime.bot, nodes)
  // Yunzai 的通用适配层识别 node 段；保留这个标准形态可覆盖没有暴露
  // makeForwardMsg 方法、但仍支持合并转发的 OneBot 兼容适配器。
  return { type: "node", data: nodes }
}

function messageIdFrom(value: unknown): string {
  const source = record(value)
  return text(source.message_id || source.messageId || source.id)
}

/**
 * 解析当前会话的发送方法。
 *
 * 只发当前会话：跨会话投递已经取消，谁触发就回给谁。这样也不存在
 * "模型猜一个目标 ID 结果发错群" 的可能。
 */
async function resolveSender(context: MessageChainDeliveryContext): Promise<ResolvedSender> {
  const event = record(context.e)
  if (typeof event.reply !== "function") throw new Error("当前事件不支持消息投递。")
  const reply = event.reply as (payload: unknown, quote?: boolean) => unknown
  return {
    label: event.isGroup ? `群 ${text(event.group_id)}` : `用户 ${text(event.user_id || record(event.sender).user_id)}`,
    send: (payload, quote) => reply(payload, quote),
  }
}

function partType(part: ContentPart): ContentPart["type"] {
  return part.type
}

/**
 * 将内部消息链一次性按顺序投递到宿主。
 *
 * 这里是唯一的通用媒体发送入口：不识别 MCP 原始 JSON，不猜测 URL 的语义，
 * 只执行模型已经明确选择的 OutboundPart，并为每个片段留下发送回执。
 */
export async function deliverMessageChain(chain: MessageChain, context: MessageChainDeliveryContext = {}): Promise<DeliveryReceipt> {
  const config = context.config || configStore.get() as unknown as UnknownRecord
  const receiptId = context.operationId || `delivery_${crypto.randomUUID()}`
  const parts: PartDeliveryReceipt[] = []
  const prepared: Array<{ index: number; payload: unknown; forward: boolean }> = []
  for (let index = 0; index < chain.length; index++) {
    const part = chain[index]
    try {
      if (!["text", "mention", "reply", "image", "audio", "video", "file", "music", "forward"].includes(part.type)) throw new Error(`片段 ${part.type} 不能直接发送。`)
      const outbound = part as OutboundPart
      const value = "source" in outbound ? await resourceValue(outbound.source, config) : ""
      // 艾特后面紧跟文字时补一个空格：多数客户端不加空格会把 @昵称 和后续
      // 文字连在一起渲染，甚至影响艾特本身的解析。文本 CQ 路径一直有这个
      // 规范化，消息链路径必须保持一致。
      if (outbound.type === "forward") {
        prepared.push({ index, payload: await forwardSegment(outbound, context, config), forward: true })
      } else if (outbound.type === "text" && chain[index - 1]?.type === "mention" && !/^\s/.test(outbound.text)) {
        prepared.push({ index, payload: ` ${outbound.text}`, forward: false })
      } else {
        prepared.push({ index, payload: segmentFor(outbound, value), forward: false })
      }
      parts.push({ index, type: partType(part), status: "sent" })
    } catch (error) {
      parts.push({ index, type: partType(part), status: "failed", error: text(record(error).message || error).slice(0, 300) })
    }
  }
  if (!prepared.length) {
    return { id: receiptId, status: "failed", partCount: chain.length, sentCount: 0, failedCount: parts.length || chain.length, parts, error: parts.map(item => item.error).filter(Boolean).join("；") || "没有可发送的消息链片段。" }
  }
  const batches: Array<{ forward: boolean; items: typeof prepared }> = []
  for (const item of prepared) {
    const current = batches[batches.length - 1]
    // OneBot 会把同一个 payload 中的 node 抽出并优先发送。这里主动分批，
    // 才能严格保持 message_send 中“正文在前、来源转发在后”的顺序。
    if (item.forward || !current || current.forward) batches.push({ forward: item.forward, items: [item] })
    else current.items.push(item)
  }
  const messageIds: string[] = []
  let quotePending = context.quote ?? deliveryConfig(config).quoteReply
  let sender: ResolvedSender
  try {
    sender = await resolveSender(context)
  } catch (error) {
    const message = text(record(error).message || error).slice(0, 500)
    for (const part of parts) if (part.status === "sent") { part.status = "failed"; part.error = message }
    return { id: receiptId, status: "failed", partCount: chain.length, sentCount: 0, failedCount: chain.length, parts, error: message }
  }
  for (const batch of batches) {
    try {
      const payloads = batch.items.map(item => item.payload)
      const result = await sender.send(payloads.length === 1 ? payloads[0] : payloads, batch.forward ? false : quotePending)
      quotePending = false
      const messageId = messageIdFrom(result)
      if (messageId) messageIds.push(messageId)
      for (const item of batch.items) {
        const receipt = parts.find(part => part.index === item.index)
        if (receipt && messageId) receipt.messageId = messageId
      }
    } catch (error) {
      const message = text(record(error).message || error).slice(0, 500)
      for (const item of batch.items) {
        const receipt = parts.find(part => part.index === item.index)
        if (receipt) { receipt.status = "failed"; receipt.error = message }
      }
    }
  }
  const sentCount = parts.filter(item => item.status === "sent").length
  const failedCount = chain.length - sentCount
  return {
    id: receiptId,
    status: sentCount ? (failedCount ? "partial" : "sent") : "failed",
    partCount: chain.length,
    sentCount,
    failedCount,
    parts,
    ...(messageIds.length ? { messageIds: [...new Set(messageIds)] } : {}),
    ...(failedCount ? { error: parts.map(item => item.error).filter(Boolean).join("；") || "部分消息链片段无法发送。" } : {}),
  }
}
