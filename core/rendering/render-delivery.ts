import { replyMessageChain } from "../message-chain/delivery.js"
import { mediaResourceFromValue } from "../message-chain/builder.js"
import type { MessageChain, ImagePart, ResourceRef, MessageDestination } from "../message-chain/types.js"
import { configStore } from "../../config/store.js"
import { renderImageByKind } from "./render-service.js"
import { hostRuntime } from "../runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>

interface RenderEvent extends UnknownRecord {
  isGroup?: boolean
  isMaster?: boolean
  group_id?: unknown
  user_id?: unknown
  sender?: UnknownRecord
  reply?: (payload: unknown, quote?: boolean) => unknown
}


interface RenderConfig {
  response?: UnknownRecord
}

interface DeliveryConfig {
  quoteReply: boolean
  allowTargetSend: boolean
}

interface RenderResult extends UnknownRecord {
  buffer?: unknown
  base64?: unknown
  url?: unknown
  file?: unknown
}

interface DeliveryOptions extends UnknownRecord {
  label?: unknown
  quote?: boolean
  targetType?: unknown
  targetId?: unknown
  groupId?: unknown
  userId?: unknown
}

interface DeliveryContext extends UnknownRecord {
  e?: RenderEvent
  config?: RenderConfig
}

interface ResolvedTarget {
  label: string
  destination?: MessageDestination
}

const pngHeader = "89504e470d0a1a0a"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}


function deliveryConfig(config: RenderConfig | unknown = {}): DeliveryConfig {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  const delivery = record(render.delivery)
  return {
    quoteReply: delivery.quoteReply !== false,
    allowTargetSend: delivery.allowTargetSend === true,
  }
}

export function currentRenderTarget(e: RenderEvent = {}): string {
  return e.isGroup ? `群 ${text(e.group_id)}` : `用户 ${text(e.user_id || e.sender?.user_id)}`
}

/** @deprecated 仅保留公开兼容出口；插件内部通过 MessageChain 投递渲染结果。 */
export function imageSegmentFromRender(result: RenderResult = {}): unknown {
  if (Buffer.isBuffer(result.buffer)) return hostRuntime.messageSegment({ type: "image", source: mediaResourceFromValue(result.buffer) }, result.buffer)
  if (result.base64) return hostRuntime.messageSegment({ type: "image", source: renderResource(result) }, `base64://${text(result.base64).replace(/^base64:\/\//, "")}`)
  if (result.url) return hostRuntime.messageSegment({ type: "image", source: renderResource(result) }, result.url)
  if (result.file) return hostRuntime.messageSegment({ type: "image", source: renderResource(result) }, result.file)
  throw new Error("渲染结果没有可发送的图片内容。")
}

export function assertRenderImage(result: RenderResult = {}): void {
  if (Buffer.isBuffer(result.buffer) && result.buffer.subarray(0, 8).toString("hex") !== pngHeader) {
    throw new Error("渲染结果不是有效 PNG。")
  }
}

function renderResource(result: RenderResult): ResourceRef {
  if (Buffer.isBuffer(result.buffer)) return mediaResourceFromValue(result.buffer)
  if (result.base64) return mediaResourceFromValue(`base64://${text(result.base64).replace(/^base64:\/\//, "")}`)
  if (result.url) return { kind: "url", value: text(result.url) }
  if (result.file) return { kind: "path", value: text(result.file) }
  throw new Error("渲染结果没有可发送的图片内容。")
}

function normalizeImages(input: unknown = []): MessageChain {
  const values = Array.isArray(input) ? input : [input]
  const images: ImagePart[] = []
  for (const item of values) {
    if (!item) continue
    let source: ResourceRef
    if (Buffer.isBuffer(item)) source = mediaResourceFromValue(item)
    else if (typeof item === "object") {
      const value = item as RenderResult
      if (!value.buffer && !value.url && !value.base64 && !value.file) continue
      assertRenderImage(value)
      source = renderResource(value)
    } else {
      const value = text(item).trim()
      if (!value) continue
      source = mediaResourceFromValue(value)
    }
    images.push({ type: "image", source })
  }
  return images
}

async function targetFromOptions(e: RenderEvent, opts: DeliveryOptions = {}, config: RenderConfig | unknown = {}): Promise<ResolvedTarget> {
  const targetType = text(opts.targetType).trim().toLowerCase()
  const targetId = text(opts.targetId || opts.groupId || opts.userId).trim()
  if (!targetType && !targetId) {
    if (!hostRuntime.canSendMessage(e)) throw new Error("当前事件不支持回复。")
    return { label: currentRenderTarget(e) }
  }

  const cfg = deliveryConfig(config)
  if (!cfg.allowTargetSend) throw new Error("跨目标发送渲染图片默认关闭。")
  if (!e.isMaster) throw new Error("跨目标发送渲染图片仅允许主人使用。")
  if (!targetId) throw new Error("缺少目标 ID。")

  const type = targetType === "group" || opts.groupId ? "group" : targetType === "user" || opts.userId ? "user" : ""
  if (type) {
    const destination: MessageDestination = { type, id: targetId }
    await hostRuntime.requireMessageDestination(destination, e)
    return { label: `${type === "group" ? "群" : "用户"} ${targetId}`, destination }
  }

  throw new Error(`未知发送目标类型：${targetType}`)
}

/**
 * 渲染交付门面：只负责把可信渲染结果转成宿主图片消息并投递。
 * 渲染算法和跨目标权限分别由渲染服务与配置控制；图片按请求即时生成，不保留渲染缓存。
 */
export async function deliverRenderedImage(result: RenderResult = {}, context: DeliveryContext = {}, opts: DeliveryOptions = {}): Promise<string> {
  const config = context.config || configStore.get() as RenderConfig
  assertRenderImage(result)
  const event = context.e
  if (!event || !hostRuntime.canSendMessage(event)) {
    return `${text(opts.label) || "图片"}渲染完成：${Buffer.isBuffer(result.buffer) ? result.buffer.length : 0} bytes`
  }
  const target = await targetFromOptions(event, opts, config)
  await replyMessageChain([{ type: "image", source: renderResource(result) }], { e: event, config: config as UnknownRecord, destination: target.destination, quote: opts.quote ?? deliveryConfig(config).quoteReply, recordImages: !opts.targetType && !opts.targetId && !opts.groupId && !opts.userId })
  return `已向 ${target.label} 发送${text(opts.label) || "渲染图片"}。`
}

export async function renderAndDeliverImage(kind: unknown, input: UnknownRecord = {}, context: DeliveryContext = {}, opts: DeliveryOptions = {}): Promise<string> {
  const config = context.config || configStore.get() as RenderConfig
  const result = await renderImageByKind(kind, input, config) as RenderResult
  return deliverRenderedImage(result, { ...context, config }, opts)
}

export async function deliverImages(images: unknown = [], context: DeliveryContext = {}, opts: DeliveryOptions = {}): Promise<string> {
  const config = context.config || configStore.get() as RenderConfig
  const payload = normalizeImages(images)
  if (!payload.length) return "没有可发送的图片。"
  const event = context.e
  if (!event || !hostRuntime.canSendMessage(event)) return `图片准备完成：${payload.length} 张。`
  const target = await targetFromOptions(event, opts, config)
  await replyMessageChain(payload, { e: event, config: config as UnknownRecord, destination: target.destination, quote: opts.quote ?? deliveryConfig(config).quoteReply, recordImages: !opts.targetType && !opts.targetId && !opts.groupId && !opts.userId })
  return `已向 ${target.label} 发送 ${payload.length} 张图片。`
}

export const renderDelivery = {
  currentRenderTarget,
  imageSegmentFromRender,
  assertRenderImage,
  deliverRenderedImage,
  renderAndDeliverImage,
  deliverImages,
}
