import path from "node:path"
import { configStore, tempDir } from "../../config/store.js"
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
  bot?: RenderBot
}

interface RenderBot {
  pickGroup?: (id: number, noCache?: boolean) => Promise<RenderTarget | null> | RenderTarget | null
  pickUser?: (id: number, noCache?: boolean) => Promise<RenderTarget | null> | RenderTarget | null
}

interface RenderTarget {
  sendMsg?: (payload: unknown) => Promise<unknown> | unknown
}

interface RenderConfig {
  response?: UnknownRecord
}

interface DeliveryConfig {
  quoteReply: boolean
  allowTargetSend: boolean
  allowFilePathImages: boolean
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
  send: (payload: unknown) => Promise<unknown> | unknown
}

const pngHeader = "89504e470d0a1a0a"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function imageSegment(value: unknown): unknown {
  const image = hostRuntime.segment?.image
  if (typeof image !== "function") throw new Error("宿主未提供图片消息段能力。")
  return image(value)
}

function deliveryConfig(config: RenderConfig | unknown = {}): DeliveryConfig {
  const root = record(config)
  const response = record(root.response)
  const render = record(response.render)
  const delivery = record(render.delivery)
  return {
    quoteReply: delivery.quoteReply !== false,
    allowTargetSend: delivery.allowTargetSend === true,
    allowFilePathImages: delivery.allowFilePathImages === true,
  }
}

export function currentRenderTarget(e: RenderEvent = {}): string {
  return e.isGroup ? `群 ${text(e.group_id)}` : `用户 ${text(e.user_id || e.sender?.user_id)}`
}

export function imageSegmentFromRender(result: RenderResult = {}): unknown {
  if (Buffer.isBuffer(result.buffer)) return imageSegment(result.buffer)
  if (result.base64) return imageSegment(`base64://${text(result.base64).replace(/^base64:\/\//, "")}`)
  if (result.url) return imageSegment(result.url)
  if (result.file) return imageSegment(result.file)
  throw new Error("渲染结果没有可发送的图片内容。")
}

export function assertRenderImage(result: RenderResult = {}): void {
  if (Buffer.isBuffer(result.buffer) && result.buffer.subarray(0, 8).toString("hex") !== pngHeader) {
    throw new Error("渲染结果不是有效 PNG。")
  }
}

function safeLocalImageFile(file: unknown = "", config: RenderConfig | unknown = {}): boolean {
  const cfg = deliveryConfig(config)
  if (!cfg.allowFilePathImages) return false
  const resolved = path.resolve(text(file))
  const tempBase = path.resolve(tempDir)
  return resolved.startsWith(`${tempBase}${path.sep}`)
}

function normalizeImages(input: unknown = [], config: RenderConfig | unknown = {}): unknown[] {
  const values = Array.isArray(input) ? input : [input]
  const images: unknown[] = []
  for (const item of values) {
    if (!item) continue
    if (Buffer.isBuffer(item)) {
      images.push(imageSegment(item))
      continue
    }
    if (typeof item === "object" && item !== null) {
      const value = item as UnknownRecord
      if (Buffer.isBuffer(value.buffer)) {
        assertRenderImage(value)
        images.push(imageSegmentFromRender(value))
      } else if (value.url || value.base64 || value.file) {
        if (value.file && !safeLocalImageFile(value.file, config)) throw new Error("本地图片路径未被允许发送。")
        images.push(imageSegmentFromRender(value))
      }
      continue
    }
    const value = text(item).trim()
    if (!value) continue
    if (/^file:/i.test(value) || path.isAbsolute(value)) {
      if (!safeLocalImageFile(value.replace(/^file:/i, ""), config)) throw new Error("本地图片路径未被允许发送。")
    }
    images.push(imageSegment(value))
  }
  return images
}

async function targetFromOptions(e: RenderEvent, opts: DeliveryOptions = {}, config: RenderConfig | unknown = {}): Promise<ResolvedTarget> {
  const targetType = text(opts.targetType).trim().toLowerCase()
  const targetId = text(opts.targetId || opts.groupId || opts.userId).trim()
  if (!targetType && !targetId) {
    if (typeof e.reply !== "function") throw new Error("当前事件不支持回复。")
    return { label: currentRenderTarget(e), send: payload => e.reply?.(payload, opts.quote ?? deliveryConfig(config).quoteReply) }
  }

  const cfg = deliveryConfig(config)
  if (!cfg.allowTargetSend) throw new Error("跨目标发送渲染图片默认关闭。")
  if (!e.isMaster) throw new Error("跨目标发送渲染图片仅允许主人使用。")
  if (!targetId) throw new Error("缺少目标 ID。")

  const bot = e.bot
  if (targetType === "group" || opts.groupId) {
    const group = await bot?.pickGroup?.(Number(targetId), true)
    if (!group?.sendMsg) throw new Error(`无法获取群 ${targetId}。`)
    return { label: `群 ${targetId}`, send: payload => group.sendMsg?.(payload) }
  }
  if (targetType === "user" || opts.userId) {
    const user = await bot?.pickUser?.(Number(targetId), true)
    if (!user?.sendMsg) throw new Error(`无法获取用户 ${targetId}。`)
    return { label: `用户 ${targetId}`, send: payload => user.sendMsg?.(payload) }
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
  if (!event?.reply) {
    return `${text(opts.label) || "图片"}渲染完成：${Buffer.isBuffer(result.buffer) ? result.buffer.length : 0} bytes`
  }
  const target = await targetFromOptions(event, opts, config)
  await target.send(imageSegmentFromRender(result))
  return `已向 ${target.label} 发送${text(opts.label) || "渲染图片"}。`
}

export async function renderAndDeliverImage(kind: unknown, input: UnknownRecord = {}, context: DeliveryContext = {}, opts: DeliveryOptions = {}): Promise<string> {
  const config = context.config || configStore.get() as RenderConfig
  const result = await renderImageByKind(kind, input, config) as RenderResult
  return deliverRenderedImage(result, { ...context, config }, opts)
}

export async function deliverImages(images: unknown = [], context: DeliveryContext = {}, opts: DeliveryOptions = {}): Promise<string> {
  const config = context.config || configStore.get() as RenderConfig
  const payload = normalizeImages(images, config)
  if (!payload.length) return "没有可发送的图片。"
  const event = context.e
  if (!event?.reply) return `图片准备完成：${payload.length} 张。`
  const target = await targetFromOptions(event, opts, config)
  await target.send(payload.length === 1 ? payload[0] : payload)
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
