import { validateOutboundMessageChain } from "../../core/message-chain/validation.js"
import { MusicPlayTool } from "./music.js"
import fs from "node:fs/promises"
import path from "node:path"
import { configStore } from "../../config/store.js"
import { defaults } from "../../config/defaults.js"
import { mediaCacheDir, prepareMediaForVision } from "../../core/media/media-cache.js"
import { buildMediaUserContent, resolveMediaContext, summarizeMediaContext } from "../../core/message/media-context.js"
import type { ResolvedMediaContext } from "../../core/message/media-context.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { adapterRegistry } from "../../models/adapters/registry.js"
import { providerResolver, type ResolvedModelChannel } from "../../models/routing/provider-resolver.js"
import type { ModelMessage } from "../../models/protocol/types.js"
import { deliverMessageChain, replyMessageChain } from "../../core/message-chain/delivery.js"
import { MessageChainBuilder } from "../../core/message-chain/builder.js"
import type { ContentPart, ForwardNode, ForwardNodePart, MusicPart, ResourceRef, ToolOutput } from "../../core/message-chain/types.js"
import { fetchBilibiliVideoBuffer, fetchBilibiliVideoDetail } from "./bilibili.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { fetchSafeHttp } from "../../core/network/safe-http-client.js"
import { resolveTrustedResourceRequest, trustedResourceRequest } from "../../core/network/link-safety-policy.js"
import { toByteView } from "../../core/shared/bytes.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"
import { GenerateImageTool } from "./image-generation.js"

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

function mediaResource(value: unknown): ResourceRef {
  const source = record(value)
  return {
    kind: source.kind as ResourceRef["kind"],
    value: text(source.value).trim(),
    ...(source.mimeType ? { mimeType: text(source.mimeType) } : {}),
    ...(source.name ? { name: text(source.name) } : {}),
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
  if (type === "audio") return "audio"
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
  const requested = text(item.userId).trim()
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
    const item = record(raw)
    const requestedType = text(item.type).trim().toLowerCase()
    const type = requestedType
    const mediaType = normalizedMediaType(type)
    if (!mediaType && !["text", "mention", "reply", "music", "dice", "rps"].includes(type) && !(allowForward && type === "forward")) {
      issues.push(`媒体项 ${index + 1} 的 type 不支持：${text(item.type)}`)
      continue
    }
    if (type === "forward") {
      const forward = forwardNodes(item.nodes, context)
      if (forward.issues.length) issues.push(...forward.issues.map(issue => `消息项 ${index + 1}：${issue}`))
      else builder.forward(forward.nodes)
    } else if (type === "dice") {
      builder.dice()
    } else if (type === "rps") {
      builder.rps(Number(item.value))
    } else if (type === "text") {
      builder.text(item.text)
    } else if (type === "mention") {
      const userId = mentionUserId(item, context)
      if (!userId) issues.push(`消息项 ${index + 1} 无法确定要艾特的用户。`)
      else builder.mention(userId)
    } else if (type === "reply") {
      const messageId = text(item.messageId).trim()
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
      const source = mediaResource(item.source)
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

function validateMessageItems(items: unknown[], context: MediaToolContext): string[] {
  const issues = validateOutboundMessageChain(items, { allowImplicitMention: true })
  const visit = (parts: unknown[]): void => {
    for (const raw of parts) {
      const part = record(raw)
      if (part.type === "forward" && Array.isArray(part.nodes)) {
        for (const node of part.nodes) if (Array.isArray(record(node).parts)) visit(record(node).parts as unknown[])
      } else if (part.type === "video" && isRemoteBilibiliVideoSource(mediaResource(part.source))) {
        issues.push("B 站视频请使用 bilibili_media(action=send) 返回的本地 source，再传入 kind=path 的视频资源。")
      } else if (part.type === "mention" && !mentionUserId(part, context)) issues.push("无法确定要艾特的用户。")
    }
  }
  if (!issues.length) visit(items)
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
    quote: typeof context.delivery?.quote === "boolean" ? context.delivery.quote : undefined,
    operationId: text(context.execution?.operationId),
    signal: context.agent?.signal || context.signal,
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
    metadata: { deliveryAttempted: true, filterTraces: (receipt.filterTraces || []) as import("../../core/message-chain/types.js").JsonValue[] },
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
        maxTokens: Math.max(1, Number(record(record(config.modelTasks)[taskName]).maxTokens) || defaults.modelTasks.replyer.maxTokens),
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
      await replyMessageChain([{ type: "text", text: command }], { e: context.e, config, quote: response.quoteReply === true, textFiltered: true })
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
    return { kind: "path", value: file, mimeType: type.mimeType, name: `${videoId}_cover${type.extension}` }
  }
  if (inline) {
    const bytes = Buffer.from(inline[2].replace(/\s+/g, ""), "base64")
    if (!bytes.length) throw new Error("B 站封面内容为空。")
    await fs.writeFile(file, toByteView(bytes))
    return { kind: "path", value: file, mimeType: type.mimeType, name: `${videoId}_cover${type.extension}` }
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
  return { kind: "path", value: file, mimeType, name: `${videoId}_cover${type.extension}` }
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
      source: { kind: "path", value: file, mimeType: "video/mp4" },
      hint: "封面和视频均已准备为本地缓存资源。用 message_send 按顺序发送简介 text、coverSource 对应的 image、source 对应的 video；不要发送页面 URL 作为 video。",
    }
  }
  const buffer = await fetchBilibiliVideoBuffer(item, {
    maxBytes: cfg.maxVideoBytes,
    timeoutMs: cfg.timeoutMs,
    signal: context.agent?.signal,
  })
  await fs.writeFile(file, toByteView(buffer))
  return {
    ...details,
    bytes: buffer.length,
    cached: false,
    source: { kind: "path", value: file, mimeType: "video/mp4" },
    hint: "封面和视频均已准备为本地缓存资源。用 message_send 按顺序发送简介 text、coverSource 对应的 image、source 对应的 video；不要发送页面 URL 作为 video。",
  }
}

// 按 type 展示各自的字段；转发节点复用基本片段，不复制一套混合字段表。
const messagePartSchemas = [
  { type: "object", properties: { type: { type: "string", enum: ["text"] }, text: { type: "string" } }, required: ["type", "text"] },
  { type: "object", properties: { type: { type: "string", enum: ["mention"] }, userId: { type: "string", description: "Omit to mention the current sender." } }, required: ["type"] },
  { type: "object", properties: { type: { type: "string", enum: ["reply"] }, messageId: { type: "string" } }, required: ["type", "messageId"] },
  {
    type: "object",
    properties: {
      type: { type: "string", enum: ["image", "audio", "video", "file"] },
      source: {
        type: "object",
        // 完整性由消息校验返回可纠正错误，避免 Registry 提前耗尽发送机会。
        properties: {
          kind: { type: "string", enum: ["url", "path", "bytes"], description: "HTTP(S) URL, allowed local path, or Base64 bytes." },
          value: { type: "string" }, mimeType: { type: "string" }, name: { type: "string" },
        },
      },
      name: { type: "string" }, description: { type: "string" },
    },
    required: ["type", "source"],
  },
  {
    type: "object",
    properties: { type: { type: "string", enum: ["music"] }, platform: { type: "string", enum: ["qq", "163", "kugou", "migu", "kuwo"] }, id: { type: "string" } },
    required: ["type", "platform", "id"],
  },
  {
    type: "object",
    properties: {
      type: { type: "string", enum: ["music"] }, platform: { type: "string", enum: ["custom"] },
      url: { type: "string" }, audio: { type: "string" }, title: { type: "string" }, singer: { type: "string" }, image: { type: "string" },
    },
    required: ["type", "platform"],
  },
  { type: "object", properties: { type: { type: "string", enum: ["dice"] } }, required: ["type"] },
  { type: "object", properties: { type: { type: "string", enum: ["rps"] }, value: { type: "integer", enum: [1, 2, 3] } }, required: ["type", "value"] },
]

/**
 * 统一消息投递工具。
 *
 * 搜索/MCP 只把原始结果交给模型；模型自己从中挑出资源地址放进 parts，
 * 运行时把 parts 组装成内部 MessageChain 再交给宿主适配器发送。这里是
 * 唯一的消息出口，回执、去重和派发标记都只在这一条路径上产生。
 */
export class MessageSendTool {
  name = "message_send"
  deferLoading = false
  source = "builtin"
  risk = "medium"
  delivery = "media"
  requiresFinalReply = false
  execution = { effect: "non_idempotent", repeatPolicy: "dedupe", operationFields: ["parts"], retryPolicy: "no_ambiguous_retry", maxAttempts: 1, dispatchMarking: "deferred" }
  tags = ["message", "media", "delivery"]
  description = [
    "Send ordered parts to the current chat. Use only fields for the selected type; omit unrelated fields.",
    'Image example: {"parts":[{"type":"image","source":{"kind":"url","value":"https://example.com/image.gif"}}]}. Copy real resource addresses from tool results.',
    "Forward nodes contain basic parts, never another forward. Put a video's cover image before its video. Music custom needs url or audio; rps value: 1=rock, 2=scissors, 3=paper.",
    "Do not resend a successful delivery. The runtime controls conversation continuation.",
  ].join("\n")
  parameters = {
    type: "object",
    properties: {
      parts: {
        type: "array", minItems: 1,
        items: {
          anyOf: [
            ...messagePartSchemas,
            {
              type: "object",
              properties: {
                type: { type: "string", enum: ["forward"] },
                nodes: {
                  type: "array", minItems: 1, maxItems: 50,
                  items: {
                    type: "object",
                    properties: {
                      nickname: { type: "string" }, userId: { type: "string" }, time: { type: "number" },
                      parts: { type: "array", minItems: 1, items: { anyOf: messagePartSchemas } },
                    },
                    required: ["parts"],
                  },
                },
              },
              required: ["type", "nodes"],
            },
          ],
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
  return [new MessageSendTool(), new GenerateImageTool(), new MusicPlayTool()]
}
