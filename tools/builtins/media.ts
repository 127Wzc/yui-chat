import fs from "node:fs/promises"
import path from "node:path"
import { configStore } from "../../config/store.js"
import { mediaCacheDir, prepareMediaForVision } from "../../core/media/media-cache.js"
import { buildMediaUserContent, resolveMediaContext, summarizeMediaContext } from "../../core/message/media-context.js"
import type { ResolvedMediaContext } from "../../core/message/media-context.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { adapterRegistry } from "../../models/adapters/registry.js"
import { providerResolver, type ResolvedModelChannel } from "../../models/routing/provider-resolver.js"
import type { ModelMessage } from "../../models/protocol/types.js"
import { requireMethod } from "./shared.js"
import { deliverMessageChain } from "../../core/message-chain/delivery.js"
import { MessageChainBuilder } from "../../core/message-chain/builder.js"
import type { ContentPart, ForwardNode, ForwardNodePart, MusicPart, ResourceRef, ToolOutput } from "../../core/message-chain/types.js"
import { fetchBilibiliVideoBuffer, fetchBilibiliVideoDetail } from "./bilibili.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { fetchSafeHttp } from "../../core/network/safe-http-client.js"
import { resolveTrustedResourceRequest, trustedResourceRequest } from "../../core/network/link-safety-policy.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"

interface MediaToolContext extends ToolExecutionContext {
  e?: UnknownRecord
  config?: UnknownRecord
  media?: Partial<ResolvedMediaContext>
  delivery?: UnknownRecord
  toolConfig?: UnknownRecord
}

type ToolArgs = UnknownRecord

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function resourceKind(value: string): ResourceRef["kind"] {
  if (/^https?:\/\//i.test(value)) return "url"
  if (/^(?:data:|base64:\/\/)/i.test(value)) return "base64"
  if (/^file:/i.test(value) || value.startsWith("/") || /^[a-z]:[\\/]/i.test(value)) return "file"
  return "platform"
}

function mediaResource(value: unknown, item: UnknownRecord = {}): ResourceRef {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = record(value)
    const sourceValue = text(source.value || source.url || source.path || source.file || source.src).trim()
    if (sourceValue) return {
      kind: typeof source.kind === "string" ? source.kind as ResourceRef["kind"] : resourceKind(sourceValue),
      value: sourceValue,
      ...(source.mimeType ? { mimeType: text(source.mimeType) } : {}),
      ...(source.name ? { name: text(source.name) } : {}),
      ...(source.inlineData ? { inlineData: text(source.inlineData) } : {}),
    }
  }
  const scalarValue = value && typeof value === "object" ? "" : value
  const uri = text(scalarValue || item.url || item.path || item.file || item.src).trim()
  return {
    kind: resourceKind(uri),
    value: uri,
    ...(item.mimeType ? { mimeType: text(item.mimeType) } : {}),
    ...(item.name ? { name: text(item.name) } : {}),
  }
}

function isRemoteBilibiliVideoSource(source: ResourceRef): boolean {
  if (source.kind !== "url") return false
  return Boolean(resolveTrustedResourceRequest(source.value, ["bilibili-page"]))
}

interface MediaChainResult {
  chain: ContentPart[]
  issues: string[]
}

type MediaItemType = "image" | "audio" | "video" | "file"

function normalizedMediaType(value: unknown): MediaItemType | null {
  const type = text(value).trim().toLowerCase()
  if (type === "image") return "image"
  if (["audio", "record", "voice"].includes(type)) return "audio"
  if (type === "video") return "video"
  if (type === "file") return "file"
  return null
}

/**
 * 解析艾特目标。
 *
 * 模型手抄 QQ 号非常不可靠（实测会写出 JSON 碎片），而运行时本来就知道
 * 当前是谁触发的。所以只接受纯数字 ID；拿不到合法值时回落到当前发言人，
 * 而不是把一段垃圾字符串当作用户发出去。
 */
function mentionUserId(item: UnknownRecord, context: MediaToolContext): string {
  const requested = text(item.userId || item.qq || item.id).trim()
  if (/^\d{5,12}$/.test(requested)) return requested
  const sender = record(context.e?.sender)
  return text(context.e?.user_id || sender.user_id || "").trim()
}

const musicPlatforms = ["qq", "163", "kugou", "migu", "kuwo", "custom"] as const

function musicPlatform(value: unknown): MusicPart["platform"] {
  const platform = text(value).trim().toLowerCase()
  return (musicPlatforms as readonly string[]).includes(platform) ? platform as MusicPart["platform"] : "qq"
}

function forwardNodes(value: unknown, context: MediaToolContext): { nodes: ForwardNode[]; issues: string[] } {
  if (!Array.isArray(value) || !value.length) return { nodes: [], issues: ["合并转发缺少非空 nodes 数组。"] }
  const nodes: ForwardNode[] = []
  const issues: string[] = []
  for (const [index, raw] of value.slice(0, 50).entries()) {
    const node = record(raw)
    if (!Array.isArray(node.parts) || !node.parts.length) {
      issues.push(`转发节点 ${index + 1} 缺少非空 parts 数组。`)
      continue
    }
    const nested = mediaChain(node.parts, context, false)
    if (nested.issues.length) {
      issues.push(...nested.issues.map(issue => `转发节点 ${index + 1}：${issue}`))
      continue
    }
    if (!nested.chain.length) {
      issues.push(`转发节点 ${index + 1} 没有可发送内容。`)
      continue
    }
    nodes.push({
      parts: nested.chain as ForwardNodePart[],
      ...(text(node.nickname).trim() ? { nickname: text(node.nickname).trim().slice(0, 80) } : {}),
      ...(text(node.userId).trim() ? { userId: text(node.userId).trim() } : {}),
      ...(Number.isFinite(Number(node.time)) ? { time: Number(node.time) } : {}),
    })
  }
  if (value.length > 50) issues.push("单条合并转发最多支持 50 个节点。")
  return { nodes, issues }
}

function mediaChain(items: unknown[] = [], context: MediaToolContext = {}, allowForward = true): MediaChainResult {
  const builder = new MessageChainBuilder()
  const issues: string[] = []
  for (const [index, raw] of items.entries()) {
    if (typeof raw === "string") {
      const source = mediaResource(raw)
      if (!source.value) issues.push(`媒体项 ${index + 1} 缺少资源。`)
      else builder.image(source)
      continue
    }
    const item = record(raw)
    const requestedType = text(item.type).trim().toLowerCase()
    const type = requestedType || "image"
    const mediaType = normalizedMediaType(type)
    if (!mediaType && !["text", "mention", "at", "reply", "music"].includes(type) && !(allowForward && type === "forward")) {
      issues.push(`媒体项 ${index + 1} 的 type 不支持：${text(item.type)}`)
      continue
    }
    if (type === "forward") {
      const forward = forwardNodes(item.nodes, context)
      if (forward.issues.length) issues.push(...forward.issues.map(issue => `消息项 ${index + 1}：${issue}`))
      else builder.forward(forward.nodes)
    } else if (type === "text") {
      builder.text(item.text || item.content)
    } else if (type === "mention" || type === "at") {
      const userId = mentionUserId(item, context)
      if (!userId) issues.push(`消息项 ${index + 1} 无法确定要艾特的用户。`)
      else builder.mention(userId)
    } else if (type === "reply") {
      const messageId = text(item.messageId || item.id).trim()
      if (!messageId) issues.push(`消息项 ${index + 1} 缺少 messageId。`)
      else builder.reply(messageId)
    } else if (type === "music") {
      const platform = musicPlatform(item.platform)
      const id = text(item.id).trim()
      const url = text(item.url).trim()
      const audio = text(item.audio).trim()
      if (platform === "custom" && !url && !audio) {
        issues.push(`消息项 ${index + 1} 的自定义音乐卡片至少需要 url 或 audio。`)
      } else if (platform !== "custom" && !id) {
        issues.push(`消息项 ${index + 1} 缺少音乐 id；平台歌曲必须提供 id。`)
      } else {
        builder.music({
          platform,
          ...(id ? { id } : {}),
          ...(url ? { url } : {}),
          ...(audio ? { audio } : {}),
          ...(text(item.title) ? { title: text(item.title) } : {}),
          ...(text(item.singer) ? { singer: text(item.singer) } : {}),
          ...(text(item.image) ? { image: text(item.image) } : {}),
        })
      }
    } else if (mediaType) {
      const source = mediaResource(item.source || item.url || item.path || item.file || item.src, item)
      if (!source.value) {
        issues.push(`媒体项 ${index + 1} 缺少 source；请使用工具结果里给出的 url 或内联资源令牌。`)
      } else {
        const options = { name: text(item.name) || undefined, description: text(item.description) || undefined }
        if (mediaType === "image") builder.image(source, options)
        else if (mediaType === "audio") builder.audio(source, options)
        else if (mediaType === "video") builder.video(source, options)
        else builder.file(source, options)
      }
    }
  }
  return { chain: builder.build(), issues }
}

function validateMessageItems(items: unknown[], context: MediaToolContext, prefix = "消息项", allowForward = true): string[] {
  const issues: string[] = []
  for (const [index, raw] of items.entries()) {
    const label = `${prefix} ${index + 1}`
    const item = record(raw)
    const type = text(item.type).trim().toLowerCase()
    if (!["text", "mention", "reply", "image", "audio", "video", "file", "music", ...(allowForward ? ["forward"] : [])].includes(type)) {
      issues.push(`${label} 的 type 不支持：${text(item.type) || "空"}。`)
      continue
    }
    if (type === "forward") {
      if (!Array.isArray(item.nodes) || !item.nodes.length) {
        issues.push(`${label} 缺少非空 nodes 数组。`)
        continue
      }
      if (item.nodes.length > 50) issues.push(`${label} 最多支持 50 个节点。`)
      for (const [nodeIndex, rawNode] of item.nodes.slice(0, 50).entries()) {
        const node = record(rawNode)
        if (!Array.isArray(node.parts) || !node.parts.length) issues.push(`${label} 的节点 ${nodeIndex + 1} 缺少非空 parts 数组。`)
        else issues.push(...validateMessageItems(node.parts, context, `${label} 的节点 ${nodeIndex + 1} 消息项`, false))
      }
    } else if (type === "music") {
      const platform = musicPlatform(item.platform)
      if (platform === "custom" && !text(item.url).trim() && !text(item.audio).trim()) issues.push(`${label} 的自定义音乐卡片至少需要 url 或 audio。`)
      else if (platform !== "custom" && !text(item.id).trim()) issues.push(`${label} 缺少音乐 id。`)
    } else if (normalizedMediaType(type)) {
      const source = mediaResource(item.source || item.url || item.path || item.file || item.src, item)
      if (!source.value) issues.push(`${label} 缺少 source.value；请把最近工具结果中的完整 source 对象原样复制回来。`)
      else if (type === "video" && isRemoteBilibiliVideoSource(source)) issues.push(`${label} 是 B 站页面或远程视频地址；请使用 bilibili_media(action=send) 返回的本地 source，再传入 kind=cache 的视频资源。`)
    } else if (type === "mention" && !mentionUserId(item, context)) {
      issues.push(`${label} 无法确定要艾特的用户。`)
    } else if (type === "reply" && !text(item.messageId || item.id).trim()) {
      issues.push(`${label} 缺少 messageId。`)
    } else if (type === "text" && !text(item.text || item.content)) {
      issues.push(`${label} 缺少 text。`)
    }
  }
  return issues
}

async function sendMessageChainAction(args: ToolArgs, context: MediaToolContext): Promise<ToolOutput> {
  if (!Array.isArray(args.items)) {
      return {
        kind: "error",
        chain: [{ type: "text", text: "缺少 items 数组；请把每个资源写成消息链片段。" }],
        isError: true,
        issues: ["缺少 items 数组。"],
        metadata: { validationError: true, retryable: true },
      }
    }
  const media = mediaChain(args.items, context)
  if (media.issues.length) {
    return {
      kind: "error",
      chain: [{ type: "text", text: media.issues.join("\n") }],
      isError: true,
      issues: media.issues,
      metadata: { validationError: true, retryable: true },
    }
  }
  const chain = media.chain
  if (!chain.length) {
    return {
      kind: "error",
      chain: [{ type: "text", text: "items 中没有可发送的消息链片段。" }],
      isError: true,
      issues: ["items 不能为空"],
      metadata: { validationError: true, retryable: true },
      }
    }
  // 只有完成本地校验、即将进入宿主投递边界时才标记 dispatched。
  // 这样参数错误仍可被运行时安全地纠正一次，而 URL/平台投递失败会被
  // 视为已经尝试过，不会因为结果不确定而重复发送。
  context.execution?.markDispatched?.()
  const receipt = await deliverMessageChain(chain, {
    e: context.e,
    config: context.config,
    operationId: text(context.execution?.operationId),
  })
  const failed = receipt.status === "failed"
  return {
    kind: failed ? "error" : "delivery",
    chain,
    structuredContent: {
      status: receipt.status,
      partCount: receipt.partCount,
      sentCount: receipt.sentCount,
      failedCount: receipt.failedCount,
      ...(receipt.error ? { error: receipt.error } : {}),
    },
    isError: failed,
    issues: receipt.error ? [receipt.error] : [],
    receipt,
    metadata: { deliveryAttempted: true },
  }
}

function resolveMediaRecognitionChannel(config: UnknownRecord = {}): ResolvedModelChannel | undefined {
  const recognition = record(config.mediaRecognition)
  const configured = text(recognition.recognitionModel).trim()
  if (configured) {
    const channel = providerResolver.resolveCandidateChannels({ channelId: configured, config })[0]
    if (channel) return channel
  }
  const chat = record(config.chat)
  const replyer = providerResolver.resolveCandidateChannels({ taskName: text(chat.defaultTask) || "replyer", config })
  return replyer.find(channel => channel.modelConfig?.visual) || replyer[0]
}

/** 媒体识别工具：调用视觉模型理解当前或引用消息，不负责发送媒体。 */
export class RecognizeMediaTool {
  name = "recognize_media"
  source = "builtin"
  description = "Recognize and summarize images or other media in the current or quoted message using the configured media recognition model or the main reply model."
  parameters = {
    type: "object",
    properties: {
      question: { type: "string", description: "What to inspect in the media. Defaults to a concise description." },
    },
  }

  async execute(args: ToolArgs = {}, context: MediaToolContext = {}): Promise<string> {
    const config = record(context.config || configStore.get())
    if (record(config.mediaRecognition).enabled === false) return "媒体上下文识别未启用。"
    const rawMedia = context.media || await prepareMediaForVision(
      await resolveMediaContext(context.e, context.e?.msg || context.e?.raw_message || "", config), config)
    const media = rawMedia as Partial<ResolvedMediaContext>
    if (!media.attachments?.length) return "当前消息和引用消息中没有可识别的媒体。"

    const summary = summarizeMediaContext(media)
    const question = text(args.question || "请简洁描述这些媒体内容，并指出和用户问题相关的信息。").trim()
    try {
      const channel = resolveMediaRecognitionChannel(config)
      if (!channel) throw new Error("未配置可用的媒体识别模型。")
      const adapter = adapterRegistry.get(channel.type)
      const content = buildMediaUserContent(`${question}\n\n媒体上下文：\n${summary}`, media, adapter.supportsVision && channel.modelConfig?.visual !== false)
      const taskName = text(record(config.chat).defaultTask) || "replyer"
      const result = await adapterRegistry.sendMessage({
        channel,
        messages: [
          { role: "system", content: "你是媒体理解助手。优先描述图片、视频或语音所呈现的信息；无法直接读取时，根据链接和上下文给出谨慎说明。" },
          { role: "user", content: content as unknown as ModelMessage["content"] },
        ],
        tools: [],
        event: context.e,
        maxTokens: Math.max(1, Number(record(config.modelTasks)[taskName] && record(record(config.modelTasks)[taskName]).maxTokens) || 1024),
        signal: context.agent?.signal,
        purpose: "media-recognition",
        source: "tool",
        taskName,
        trace: context.observability?.trace || null,
        parentToolId: text(context.observability?.toolCallId),
      })
      return result.text || summary
    } catch (error) {
      hostRuntime.logger?.warn?.("[yui-chat] recognize_media failed", error)
      return `媒体识别模型调用失败，以下是已解析到的媒体上下文：\n${summary}`
    }
  }
}

/** 绘图转交工具：将请求交给宿主已有绘图命令，不实现绘图算法。 */
export class DrawHandoffTool {
  name = "draw_handoff"
  source = "builtin"
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["prompt", "sendCommand"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1 }
  description = "Hand off an image generation request to an existing Yunzai drawing plugin command. Use when the user asks to draw or generate an image."
  parameters = {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image prompt or drawing description." },
      sendCommand: { type: "boolean", description: "Whether to send the drawing command immediately." },
    },
    required: ["prompt"],
  }

  async execute(args: ToolArgs = {}, context: MediaToolContext = {}): Promise<string> {
    const config = record(configStore.get())
    const response = record(config.response)
    const drawHandoff = record(response.drawHandoff)
    if (drawHandoff.enabled !== true) return "绘图转交功能未启用。"
    const prompt = text(args.prompt).trim()
    if (!prompt) return "缺少绘图 prompt。"
    const command = `${text(drawHandoff.prefix)} ${text(drawHandoff.promptPrefix)}${prompt}`.trim()
    const shouldSend = args.sendCommand ?? drawHandoff.sendCommand
    if (shouldSend && context.delivery?.allowCurrentChat !== false && context.e) {
      await requireMethod(context.e, "reply", "发送绘图命令")(command, response.quoteReply)
      return `已发送绘图命令：${command}`
    }
    const note = shouldSend && context.delivery?.allowCurrentChat === false
      ? "（当前对话不直接发送绘图指令。）"
      : ""
    return `可使用绘图命令：${command}${note}`
  }
}

function formatBilibiliDate(timestamp: unknown): string {
  const seconds = Number(timestamp)
  if (!seconds) return "-"
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false })
}

function bilibiliCoverExtension(url: string): { extension: string; mimeType: string } {
  const pathname = (() => { try { return new URL(url).pathname.toLowerCase() } catch { return "" } })()
  if (pathname.endsWith(".png")) return { extension: ".png", mimeType: "image/png" }
  if (pathname.endsWith(".webp")) return { extension: ".webp", mimeType: "image/webp" }
  if (pathname.endsWith(".gif")) return { extension: ".gif", mimeType: "image/gif" }
  return { extension: ".jpg", mimeType: "image/jpeg" }
}

async function cacheBilibiliCover(item: UnknownRecord, videoId: string, context: MediaToolContext, maxBytes: number): Promise<UnknownRecord | null> {
  const rawUrl = text(item.pic).trim()
  if (!rawUrl) return null
  const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl
  const inline = url.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([a-z0-9+/=\s]+)$/i)
  const inlineMimeType = text(inline?.[1]).toLowerCase()
  const type = inlineMimeType
    ? inlineMimeType === "image/png"
      ? { extension: ".png", mimeType: inlineMimeType }
      : inlineMimeType === "image/webp"
        ? { extension: ".webp", mimeType: inlineMimeType }
        : inlineMimeType === "image/gif"
          ? { extension: ".gif", mimeType: inlineMimeType }
          : { extension: ".jpg", mimeType: "image/jpeg" }
    : bilibiliCoverExtension(url)
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, "_")
  const file = path.join(mediaCacheDir, `bilibili_${safeId}_cover${type.extension}`)
  await fs.mkdir(mediaCacheDir, { recursive: true })
  const cached = await fs.stat(file).catch(() => null)
  if (cached?.isFile() && cached.size > 0) {
    return { kind: "cache", value: file, mimeType: type.mimeType, name: `${videoId}_cover${type.extension}` }
  }
  if (inline) {
    const bytes = Buffer.from(inline[2].replace(/\s+/g, ""), "base64")
    if (!bytes.length) throw new Error("B 站封面内容为空。")
    await fs.writeFile(file, bytes)
    return { kind: "cache", value: file, mimeType: type.mimeType, name: `${videoId}_cover${type.extension}` }
  }
  // B 站官方 CDN 只允许命中集中可信目标；私网 DNS 是否例外由统一策略决定。
  const trustedRequest = trustedResourceRequest("bilibili-cdn", url, context.config || configStore.get())
  const response = await fetchSafeHttp(trustedRequest.url, {
    allowPrivateHosts: trustedRequest.allowPrivateHosts,
    maxBytes,
    timeoutMs: 30000,
    signal: context.agent?.signal,
    headers: {
      Accept: "image/*",
      Referer: `https://www.bilibili.com/video/${videoId}`,
      "User-Agent": "Yui-Chat/0.1 bilibili-cover",
    },
  })
  if (!response.ok) throw new Error(`B 站封面下载失败：HTTP ${response.status}`)
  const mimeType = text(response.headers.get("content-type")).split(";", 1)[0].trim().toLowerCase()
  if (!mimeType.startsWith("image/")) throw new Error(`B 站封面类型无效：${mimeType || "unknown"}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length) throw new Error("B 站封面内容为空。")
  await fs.writeFile(file, bytes)
  return { kind: "cache", value: file, mimeType, name: `${videoId}_cover${type.extension}` }
}

/** 下载 B 站封面和视频本体到插件临时目录，返回可直接交给 message_send 的本地资源。 */
export async function prepareBilibiliVideoResources(args: ToolArgs, context: MediaToolContext): Promise<string | UnknownRecord> {
  const rawId = text(args.id || args.url).trim()
  if (!rawId) return "缺少 B 站视频 id/url。"
  const config = record(context.config || configStore.get())
  const cfg = { ...record(record(record(config.tools).builtin).bilibili), ...record(context.toolConfig) }
  // 管理员配置是 gate：关闭后模型参数无法强制开启。
  if (cfg.sendVideoFile === false) return "视频本体下载已被管理员关闭。"
  let item: UnknownRecord
  try {
    item = record(await fetchBilibiliVideoDetail(rawId))
  } catch (error) {
    throw new Error(`B 站视频信息获取失败：${text(record(error).message || error)}`, { cause: error })
  }
  const videoId = text(item.bvid || item.aid) || "video"
  const maxBytes = Math.max(1, Number(cfg.maxVideoBytes) || 64 * 1024 * 1024)
  const coverSource = await cacheBilibiliCover(item, videoId, context, maxBytes)
  const owner = record(item.owner)
  const stat = record(item.stat)
  const details = {
    id: videoId,
    title: text(item.title),
    author: text(owner.name) || "unknown",
    published: formatBilibiliDate(item.pubdate),
    stats: { view: stat.view ?? null, like: stat.like ?? null, favorite: stat.favorite ?? null },
    url: text(item.url),
    description: item.desc ? String(item.desc).slice(0, 500) : "",
    ...(coverSource ? { coverSource } : {}),
  }
  // 按视频 ID 固定文件名：同一个视频重复请求直接复用，不再重复下载。
  // 文件落在统一的媒体缓存目录，由既有的 24 小时 TTL 清理负责回收。
  const file = path.join(mediaCacheDir, `bilibili_${videoId.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4`)
  await fs.mkdir(mediaCacheDir, { recursive: true })
  const cached = await fs.stat(file).catch(() => null)
  if (cached?.isFile() && cached.size > 0) {
    return {
      ...details,
      bytes: cached.size,
      cached: true,
      source: { kind: "cache", value: file, mimeType: "video/mp4" },
      hint: "封面和视频均已准备为本地缓存资源。用 message_send 按顺序发送简介 text、coverSource 对应的 image、source 对应的 video；不要发送页面 URL 作为 video。",
    }
  }
  const buffer = await fetchBilibiliVideoBuffer(item, {
    maxBytes: cfg.maxVideoBytes,
    timeoutMs: cfg.timeoutMs,
    signal: context.agent?.signal,
  }) as Buffer
  await fs.writeFile(file, buffer)
  return {
    ...details,
    bytes: buffer.length,
    cached: false,
    source: { kind: "cache", value: file, mimeType: "video/mp4" },
    hint: "封面和视频均已准备为本地缓存资源。用 message_send 按顺序发送简介 text、coverSource 对应的 image、source 对应的 video；不要发送页面 URL 作为 video。",
  }
}

/**
 * 统一消息投递工具。
 *
 * 搜索/MCP 只把原始结果交给模型；模型自己从中挑出资源地址放进 parts，
 * 运行时把 parts 组装成内部 MessageChain 再交给宿主适配器发送。这里是
 * 唯一的消息出口，回执、去重和派发标记都只在这一条路径上产生。
 */
export class MessageSendTool {
  name = "message_send"
  source = "builtin"
  risk = "medium"
  delivery = "media"
  requiresFinalReply = false
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["parts", "target"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1, dispatchMarking: "deferred" }
  tags = ["message", "media", "delivery"]
  description = [
    "The only tool that delivers a message, always to the current chat. Send one ordered internal message chain.",
    "Part shapes:",
    "  {type:'text',text}",
    "  {type:'mention'} — omit userId to @ whoever triggered the current message; that is the normal case",
    "  {type:'reply',messageId}",
    "  {type:'image'|'audio'|'video'|'file',source:{kind:'url'|'cache',value}} — copy the address exactly from a tool result, never invent one",
    "  {type:'music',platform:'qq'|'163'|'kugou'|'migu'|'kuwo',id}",
    "  {type:'music',platform:'custom',url,audio,title,singer,image}",
    "  {type:'forward',nodes:[{nickname?,userId?,parts:[...message parts]}]} — batch multiple nodes into one merged-forward message; forward nodes cannot contain another forward",
    "A successful send completes this delivery tool. Whether the conversation continues is controlled by the originating tool and runtime, not message_send.",
  ].join("\n")
  parameters = {
    type: "object",
    properties: {
      parts: {
        type: "array",
        minItems: 1,
        description: "Ordered internal message-chain parts.",
        items: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["text", "mention", "reply", "image", "audio", "video", "file", "music", "forward"] },
            text: { type: "string", description: "Text when type=text." },
            userId: { type: "string", description: "Numeric QQ id when type=mention. Omit it to mention whoever sent the current message — that is the normal case." },
            messageId: { type: "string", description: "Quoted message id when type=reply." },
            platform: { type: "string", enum: ["qq", "163", "kugou", "migu", "kuwo", "custom"], description: "Music platform when type=music. Use custom together with url/audio for a self-hosted card." },
            id: { type: "string", description: "Song id when type=music and platform is not custom." },
            url: { type: "string", description: "Jump url when type=music and platform=custom." },
            audio: { type: "string", description: "Playable audio url when type=music and platform=custom." },
            title: { type: "string", description: "Song title when type=music and platform=custom." },
            singer: { type: "string", description: "Artist when type=music and platform=custom." },
            image: { type: "string", description: "Cover image url when type=music and platform=custom." },
            source: {
              type: "object",
              description: "Resource for media parts. Copy the address exactly as it appeared in a tool result.",
              properties: {
                kind: { type: "string", enum: ["url", "file", "cache", "base64", "platform"] },
                value: { type: "string" },
                mimeType: { type: "string" },
                name: { type: "string" },
              },
            },
            name: { type: "string", description: "Optional media name." },
            description: { type: "string", description: "Optional media description." },
            nodes: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              description: "Merged-forward nodes when type=forward. Each node has its own ordered parts array; nested forward parts are not allowed.",
              items: {
                type: "object",
                required: ["parts"],
                properties: {
                  nickname: { type: "string", description: "Optional display name for this node." },
                  userId: { type: "string", description: "Optional numeric sender id for this node." },
                  time: { type: "number", description: "Optional Unix timestamp." },
                  parts: { type: "array", minItems: 1, description: "Ordered text/media/mention/reply/music parts for this node. Nested forward is not allowed.", items: { type: "object" } },
                },
              },
            },
          },
        },
      },
    },
    required: ["parts"],
  }

  async execute(args: ToolArgs = {}, context: MediaToolContext = {}): Promise<ToolOutput> {
    if (!Array.isArray(args.parts) || !args.parts.length) {
      return {
        kind: "error",
        chain: [{ type: "text", text: "message_send 必须提供非空 parts 数组。" }],
        isError: true,
        issues: ["缺少 parts 数组。"],
        metadata: { validationError: true, retryable: true },
      }
    }
    const issues = validateMessageItems(args.parts, context)
    if (issues.length) {
      return {
        kind: "error",
        chain: [{ type: "text", text: issues.join("\n") }],
        isError: true,
        issues,
        metadata: { validationError: true, retryable: true },
      }
    }
    return sendMessageChainAction({ items: args.parts }, context)
  }
}

export function createMediaTools(): unknown[] {
  return [new MessageSendTool()]
}
