import crypto from "node:crypto"
import { recentContextStore } from "../chat/recent-context.js"
import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { configStore, tempDir } from "../../config/store.js"
import { assertSafeHttpUrl, linkSafetyConfig } from "../network/link-safety-policy.js"
import { yunzaiMessageAdapter } from "../runtime/host-runtime.js"
import type { MessageAdapter, PreparedMessagePart } from "./adapter.js"
import { applyOutputChainFilters } from "../../filters/message/message-filter-service.js"
import { validateOutboundMessageChain } from "./validation.js"
import type {
  DeliveryReceipt,
  MessageChain,
  MessageDestination,
  OutboundPart,
  ResourceRef,
  PartDeliveryReceipt,
} from "./types.js"

type UnknownRecord = Record<string, unknown>

export interface MessageChainDeliveryContext {
  e?: UnknownRecord
  /** 插件内部选定的发送实现；默认使用 Yunzai。 */
  adapter?: MessageAdapter
  config?: UnknownRecord
  quote?: boolean
  operationId?: string
  signal?: AbortSignal
  replyOptions?: UnknownRecord
  /** 正文已在转图/转语音前处理，投递时只执行媒体链接规则。 */
  textFiltered?: boolean
  /** 仅供已完成目标与权限检查的插件内部投递器提供。 */
  destination?: MessageDestination
  /** 原生回执仅供内部调用方消费，不放进持久化工具结果。 */
  receipts?: unknown[]
  recordImages?: boolean
  quoteStandalone?: boolean
}


function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function deliveryConfig(config: unknown): { quoteReply: boolean; allowedLocalPaths: string[] } {
  const root = record(config)
  const delivery = record(record(record(root.response).render).delivery)
  return {
    quoteReply: delivery.quoteReply !== false,
    allowedLocalPaths: Array.isArray(delivery.allowedLocalPaths) ? delivery.allowedLocalPaths.map(String) : [],
  }
}

function isWithin(base: string, candidate: string): boolean {
  const root = path.resolve(base)
  const resolved = path.resolve(candidate)
  return resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/** 所有路径使用同一目录策略，缓存不再拥有另一种资源身份。 */
async function safeLocalPath(value: string, config: unknown): Promise<string> {
  const resolved = path.resolve(/^file:/i.test(value) ? fileURLToPath(value) : value)
  const actual = await fs.realpath(resolved)
  for (const root of [tempDir, ...deliveryConfig(config).allowedLocalPaths]) {
    try {
      const actualRoot = await fs.realpath(path.resolve(root))
      if (isWithin(actualRoot, actual)) return actual
    } catch (error) {
      // 尚未创建或已经删除的允许目录不影响其他目录，读取异常仍向上报告。
      if (!["ENOENT", "ENOTDIR"].includes(text(record(error).code))) throw error
    }
  }
  throw new Error("本地媒体的实际路径不在允许的目录内。")
}

async function resourceValue(source: ResourceRef, config: unknown): Promise<string> {
  const value = text(source.value).trim()
  if (!value) throw new Error("媒体资源为空。")
  if (source.kind === "url") {
    return assertSafeHttpUrl(value, { allowPrivateHosts: linkSafetyConfig(config).allowPrivateHosts })
  }
  if (source.kind === "path") return safeLocalPath(value, config)
  if (source.kind === "bytes") return `data:${source.mimeType || "application/octet-stream"};base64,${value}`
  throw new Error("未知媒体资源类型。")
}


async function validateMusicResources(part: OutboundPart, config: unknown): Promise<void> {
  if (part.type === "forward") {
    for (const node of part.nodes) for (const item of node.parts) await validateMusicResources(item, config)
  } else if (part.type === "music") {
    for (const key of ["audio", "image"] as const) if (part[key]) await assertSafeHttpUrl(part[key], { allowPrivateHosts: linkSafetyConfig(config).allowPrivateHosts })
  }
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
  context.signal?.throwIfAborted()
  const issues = validateOutboundMessageChain(chain)
  if (issues.length) {
    const count = Array.isArray(chain) ? chain.length : 0
    return { id: receiptId, status: "failed", partCount: count, sentCount: 0, failedCount: count, parts: [], error: issues.join("；") }
  }
  const filtered = await applyOutputChainFilters(chain, { e: context.e, config, signal: context.signal }, context.textFiltered)
  context.signal?.throwIfAborted()
  if (filtered.blocked || !filtered.chain.length) return {
    id: receiptId, status: "failed", partCount: chain.length, sentCount: 0, failedCount: chain.length, parts: [],
    blocked: true, error: filtered.reason || "过滤后没有可发送内容。", filterTraces: filtered.traces,
  }
  chain = filtered.chain
  const adapter = context.adapter || yunzaiMessageAdapter
  const adapterContext = { e: context.e, destination: context.destination, replyOptions: context.replyOptions, quoteStandalone: context.quoteStandalone }
  const parts: PartDeliveryReceipt[] = []
  const prepared: Array<PreparedMessagePart & { index: number }> = []
  for (let index = 0; index < chain.length; index++) {
    const part = chain[index]
    try {
      const outbound = part as OutboundPart
      await validateMusicResources(outbound, config)
      // 提及与紧随其后的正文保留可见间距；不修改调用方保存的消息链。
      const spaced = outbound.type === "text" && chain[index - 1]?.type === "mention" && !/^\s/.test(outbound.text)
        ? { ...outbound, text: ` ${outbound.text}` } : outbound
      prepared.push({ index, ...await adapter.prepare(spaced, adapterContext, source => resourceValue(source, config)) })
      parts.push({ index, type: part.type, status: "sent" })
    } catch (error) {
      parts.push({ index, type: part.type, status: "failed", error: text(record(error).message || error).slice(0, 300) })
    }
  }
  if (!prepared.length) {
    return { id: receiptId, status: "failed", partCount: chain.length, sentCount: 0, failedCount: parts.length || chain.length, parts, error: parts.map(item => item.error).filter(Boolean).join("；") || "没有可发送的消息链片段。" }
  }
  const batches: Array<{ standalone: boolean; items: typeof prepared }> = []
  for (const item of prepared) {
    const current = batches[batches.length - 1]
    // 适配器决定哪些片段需要独立发送，投递器按原顺序分批。
    if (item.standalone || !current || current.standalone) batches.push({ standalone: item.standalone, items: [item] })
    else current.items.push(item)
  }
  const messageIds: string[] = []
  let quotePending = context.quote ?? deliveryConfig(config).quoteReply
  if (!adapter.canSend(adapterContext)) {
    const message = "当前事件不支持消息投递。"
    for (const part of parts) if (part.status === "sent") { part.status = "failed"; part.error = message }
    return { id: receiptId, status: "failed", partCount: chain.length, sentCount: 0, failedCount: chain.length, parts, error: message }
  }
  for (const batch of batches) {
    context.signal?.throwIfAborted()
    try {
      const payloads = batch.items.map(item => item.payload)
      const quote = batch.items.every(item => item.allowQuote) && quotePending
      const { receipt: result, messageIds: sentIds } = await adapter.send(payloads.length === 1 ? payloads[0] : payloads, { ...adapterContext, quote })
      context.receipts?.push(result)
      quotePending = false
      const messageId = sentIds.length === 1 ? sentIds[0] : ""
      messageIds.push(...sentIds)
      if (context.recordImages !== false) await recentContextStore.recordDeliveredImages(context.e, result, batch.items.filter(item => chain[item.index].type === "image").length)
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
    filterTraces: filtered.traces,
    ...(messageIds.length ? { messageIds: [...new Set(messageIds)] } : {}),
    ...(failedCount ? { error: parts.map(item => item.error).filter(Boolean).join("；") || "部分消息链片段无法发送。" } : {}),
  }
}

/** 插件回复使用同一消息链投递，向已有调用方保留宿主的真实回执。 */
export async function replyMessageChain(chain: MessageChain, context: MessageChainDeliveryContext = {}): Promise<unknown> {
  if (!chain.length) return false
  const receipts: unknown[] = []
  const result = await deliverMessageChain(chain, { ...context, receipts })
  if (result.status === "failed" || result.status === "partial") throw new Error(result.error || "消息投递失败。")
  return receipts.length === 1 ? receipts[0] : { message_id: result.messageIds || [], data: receipts }
}
