import { configStore } from "../../config/store.js"
import { prepareMediaForVision } from "../../core/media/media-cache.js"
import { resolveMediaContext } from "../../core/message/media-context.js"
import type { ResolvedMediaContext } from "../../core/message/media-context.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { MessageChainBuilder } from "../../core/message-chain/builder.js"
import type { ResourceRef } from "../../core/message-chain/types.js"
import { adapterRegistry } from "../../models/adapters/registry.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import type { ImageGenerationReference } from "../../models/protocol/types.js"
import type { ToolExecutionContext } from "../support/tool-contract.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { resolveBoundaryRole } from "../access/roles.js"

type ToolArgs = UnknownRecord

interface ImageToolContext extends ToolExecutionContext {
  e?: UnknownRecord
  config?: UnknownRecord
  media?: Partial<ResolvedMediaContext>
  delivery?: UnknownRecord
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value).trim()
    if (candidate) return candidate
  }
  return ""
}

function imageValue(value: unknown): { url: string; mimeType?: string; name?: string } | null {
  const source = typeof value === "string" ? { url: value } : record(value)
  const url = text(source.url || source.value || source.src || source.image).trim()
  if (!url) return null
  if (!/^data:image\//i.test(url) && !/^https?:\/\//i.test(url)) return null
  return {
    url,
    ...(text(source.mimeType || source.mime_type) ? { mimeType: text(source.mimeType || source.mime_type) } : {}),
    ...(text(source.name) ? { name: text(source.name) } : {}),
  }
}

function mediaPrompt(event: UnknownRecord): string {
  return text(event.msg || event.raw_message || event.message || "").trim()
}

function resourceForImage(image: { data?: string; url?: string; mimeType?: string }, index: number): ResourceRef | null {
  const value = text(image.data || image.url).trim()
  if (!value) return null
  const dataUrl = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i)
  if (dataUrl) {
    return {
      kind: "base64",
      value: dataUrl[2],
      mimeType: image.mimeType || dataUrl[1] || "image/png",
      name: `generated-${index + 1}`,
    }
  }
  return {
    kind: /^https?:\/\//i.test(value) ? "url" : "base64",
    value,
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    name: `generated-${index + 1}`,
  }
}

function canDeliverToCurrentChat(context: ImageToolContext): boolean {
  // 生图完成通知本身就是显式的媒体投递；不受模型轮次中“当前会话即时发送”
  // 的抑制开关影响，避免后台任务完成后只记日志却没有图片。
  return typeof record(context.e).reply === "function"
}

function imageErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "图片生成失败")).slice(0, 500)
}

function eventUserId(event: unknown): string {
  const value = record(event)
  return text(value.user_id || value.userId || record(value.sender).user_id).trim()
}

function allowsMultipleImages(context: ImageToolContext, imageRuntime: UnknownRecord): boolean {
  if (resolveBoundaryRole(context.e) === "master") return true
  const userId = eventUserId(context.e)
  if (!userId) return false
  const allowed = Array.isArray(imageRuntime.multiImageUserIds)
    ? imageRuntime.multiImageUserIds.slice(0, 200).map(value => text(value).trim()).filter(Boolean)
    : []
  return allowed.includes(userId)
}

/** 后台完成后仍经统一 message_send 入口投递，避免复制宿主消息发送逻辑。 */
async function sendWithMessageTool(parts: unknown[], context: ImageToolContext, suffix: string): Promise<UnknownRecord> {
  const { toolRegistry } = await import("../support/registry.js")
  const parentToolId = text(context.observability?.toolCallId).trim() || "generate_image"
  const parentOperationId = text(context.execution?.operationId).trim()
  const operationId = parentOperationId ? `${parentOperationId}:${suffix}` : `${parentToolId}:${suffix}`
  const sendContext = {
    ...context,
    execution: { operationId, background: false },
    observability: {
      ...record(context.observability),
      toolCallId: `${parentToolId}:${suffix}`,
    },
  }
  const output = await toolRegistry.execute("message_send", { parts }, sendContext as Parameters<typeof toolRegistry.execute>[2])
  const source = record(output)
  const receipt = record(source.receipt)
  const issues = Array.isArray(source.issues) ? source.issues.map(text).filter(Boolean) : []
  const status = text(receipt.status || source.kind || source.status || "sent")
  if (source.kind === "error" || source.isError === true || status === "failed") {
    throw new Error(text(receipt.error || issues[0] || "消息投递失败"))
  }
  return {
    status,
    partCount: Number(receipt.partCount) || parts.length,
    sentCount: Number(receipt.sentCount) || 0,
    failedCount: Number(receipt.failedCount) || 0,
  }
}

async function sendFailureNotice(message: string, context: ImageToolContext): Promise<void> {
  if (!canDeliverToCurrentChat(context)) return
  try {
    await sendWithMessageTool([{ type: "text", text: message }], context, "failure")
  } catch (error) {
    hostRuntime.logger?.warn?.("[yui-chat] generate_image 失败通知发送失败", imageErrorText(error))
  }
}

async function prepareReferenceImages(args: ToolArgs, context: ImageToolContext, config: UnknownRecord, maxReferences = 3): Promise<ImageGenerationReference[]> {
  const referenceLimit = Math.max(0, Math.min(3, Number(maxReferences) || 0))
  const explicit = Object.hasOwn(args, "referenceImages")
  let candidates: Array<{ url: string; mimeType?: string; name?: string; source: string }> = []
  if (explicit) {
    if (!Array.isArray(args.referenceImages)) throw new Error("referenceImages 必须是数组")
    candidates = args.referenceImages.slice(0, referenceLimit).map((value, index) => {
      const item = imageValue(value)
      if (!item) throw new Error(`参考图 ${index + 1} 必须是 http(s) 或 data:image URL`)
      return { ...item, source: `tool-reference-${index + 1}` }
    })
  } else {
    const prompt = mediaPrompt(context.e || {})
    const resolved = context.media || await resolveMediaContext(context.e, prompt, config, { quoteAsCurrent: true })
    candidates = (Array.isArray(resolved.attachments) ? resolved.attachments : [])
      .filter(item => item.kind === "image" && item.visionEligible !== false)
      .slice(0, referenceLimit)
      .flatMap((item, index) => {
        // 若本轮媒体已经为视觉理解准备过，优先回到原始地址重新读取，
        // 避免把视觉链路的缓存内容当成画图参考图长期复用。
        const url = text(item.originalUrl || item.url || item.preparedUrl).trim()
        return url ? [{ url, mimeType: text(item.mimeType) || undefined, name: `reference-${index + 1}`, source: text(item.source || "message") }] : []
      })
  }
  if (!candidates.length) return []
  const prepared = await prepareMediaForVision({
    attachments: candidates.map(item => ({ kind: "image", url: item.url, mimeType: item.mimeType, source: item.source, cacheable: false, visionEligible: true })),
  }, config) as UnknownRecord
  const references = (Array.isArray(prepared.attachments) ? prepared.attachments : []).flatMap((item, index) => {
    const data = text(record(item).preparedUrl).trim()
    if (!/^data:image\//i.test(data)) return []
    return [{ data, mimeType: text(record(item).mimeType) || undefined, name: candidates[index]?.name }]
  })
  if (!references.length) throw new Error("参考图无法读取，请检查图片地址和远程媒体设置")
  return references
}

/** 统一画图工具：OpenAI Images、Gemini 图片协议和 OpenAI-compatible 图片网关共用。 */
export class GenerateImageTool {
  name = "generate_image"
  source = "builtin"
  category = "media"
  risk = "medium"
  policy = { externalNetwork: true }
  delivery = "media"
  // 工具调用可提供一条自然的开始确认；完成后的图片由后台显式投递。
  backgroundMessage = "我开始画了，完成后发给你。"
  requiresFinalReply = true
  execution = {
    effect: "non_idempotent",
    repeatPolicy: "dedupe",
    operationFields: ["prompt", "referenceImages", "count", "size", "quality", "aspectRatio", "imageSize", "background"],
    retryPolicy: "no_ambiguous_retry",
    dispatchMarking: "immediate",
    maxAttempts: 1,
    background: true,
  }
  tags = ["image", "generation", "media"]
  configSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true, title: "启用图片生成", description: "关闭后工具不会发起生图请求。" },
      maxCount: { type: "integer", minimum: 0, default: 0, title: "图片输出上限", description: "最终发送的硬上限。0 表示主人和名单用户不限制；普通用户始终最多 1 张。" },
      multiImageUserIds: { type: "array", maxItems: 200, default: [], title: "多图生成名单", description: "名单中的用户可请求多张图片；主人始终允许。填写用户 ID 数组。", items: { type: "string" } },
      maxReferences: { type: "integer", minimum: 0, maximum: 3, default: 3, title: "最多参考图", description: "参考图只在当前请求中使用，不写入缓存。" },
      defaultAspectRatio: { type: "string", default: "1:1", title: "默认比例", description: "调用未指定时使用；Gemini 示例：1:1、16:9。" },
      defaultImageSize: { type: "string", default: "1K", title: "默认尺寸", description: "调用未指定时使用；Gemini 示例：1K、2K。" },
      defaultSize: { type: "string", default: "1024x1024", title: "默认分辨率", description: "调用未指定时使用；OpenAI 示例：1024x1024、1024x1536。" },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, default: 300000, title: "请求超时（毫秒）", description: "超时后丢弃本次请求结果。" },
    },
  }
  description = "Generate or edit images with the configured image model. Omit referenceImages for text-to-image; include one or more image URLs/data URLs to edit them. When size, aspectRatio, or imageSize is omitted, the tool applies its configured defaults before the model settings. Generation runs in the background and sends all returned images to the current chat when ready. You may include startMessage for a brief natural acknowledgement that drawing has started; do not claim completion before the images arrive."
  parameters = {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 4000, description: "What to generate or how to edit the reference image." },
      referenceImages: { type: "array", maxItems: 3, description: "Optional image URLs or data URLs. Omit to use an image attached to the current message; use [] to force text-to-image.", items: { type: "string" } },
      count: { type: "integer", minimum: 1, description: "Optional target image count. It is honored only for the bot owner or configured allowlisted users; other users are always limited to one image." },
      size: { type: "string", description: "OpenAI image size such as 1024x1024, 1024x1536, or 1536x1024." },
      quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: "Image quality preset." },
      aspectRatio: { type: "string", description: "Gemini aspect ratio such as 1:1 or 16:9." },
      imageSize: { type: "string", enum: ["auto", "512", "1K", "2K", "4K"], description: "Gemini output size preset." },
      background: { type: "string", enum: ["auto", "transparent", "opaque"], description: "OpenAI background mode." },
      startMessage: { type: "string", minLength: 2, maxLength: 80, description: "One short single-line acknowledgement that drawing has started. Do not mention completion, results, model names, or elapsed time. Example: '我开始画了，完成后发给你。'" },
    },
    required: ["prompt"],
  }

  async execute(args: ToolArgs = {}, context: ImageToolContext = {}): Promise<UnknownRecord> {
    const config = record(context.config || configStore.get())
    const imageRuntime = record(context.toolConfig)
    try {
      if (imageRuntime.enabled === false) throw new Error("图片生成未启用")
      const prompt = text(args.prompt).trim()
      if (!prompt) throw new Error("请提供图片描述")
      const taskName = "imageGeneration"
      const channels = providerResolver.resolveCandidateChannels({ taskName, config })
      const channel = channels.find(item => item.purpose === "image" || ["openai-images", "openai-chat-completions", "gemini-images"].includes(item.type))
      if (!channel) throw new Error("尚未配置可用的图片模型，请先在模型服务中添加用途为“图片生成”的模型")
      const modelImage = record(record(channel.modelConfig).image)
      const modelImageParams = record(modelImage.params)
      // 参数优先级：本次工具调用 > 工具运行变量 > 图片模型配置。
      // 不同协议使用不同字段，未使用的字段会在适配器边界被忽略。
      const size = firstText(
        args.size,
        imageRuntime.defaultSize,
        modelImage.size,
        modelImage.resolution,
        modelImageParams.size,
        modelImageParams.resolution,
      )
      const aspectRatio = firstText(args.aspectRatio, imageRuntime.defaultAspectRatio, modelImage.aspectRatio, modelImageParams.aspectRatio)
      const imageSize = firstText(args.imageSize, imageRuntime.defaultImageSize, modelImage.imageSize, modelImageParams.imageSize)
      const configuredMaxCount = Number(imageRuntime.maxCount)
      const maxCount = Number.isFinite(configuredMaxCount) && configuredMaxCount > 0 ? Math.trunc(configuredMaxCount) : 0
      const hasExplicitCount = args.count !== undefined && args.count !== null && text(args.count).trim() !== ""
      const multiImageAllowed = allowsMultipleImages(context, imageRuntime)
      const targetCount = hasExplicitCount ? Math.max(1, Math.trunc(Number(args.count) || 1)) : undefined
      // maxCount 只作为最终硬上限；未传 count 时不拿它替代上游默认生成数量。
      const requestedCount = multiImageAllowed
        ? targetCount === undefined ? undefined : maxCount > 0 ? Math.min(targetCount, maxCount) : targetCount
        : 1
      const references = await prepareReferenceImages(args, context, config, imageRuntime.maxReferences === undefined ? 3 : Number(imageRuntime.maxReferences))
      const generationStartedAt = Date.now()
      const result = await adapterRegistry.generateImages({
        channel,
        prompt,
        references,
        count: requestedCount,
        size,
        quality: text(args.quality).trim(),
        aspectRatio,
        imageSize,
        background: text(args.background).trim(),
        signal: context.agent?.signal || context.signal,
        stream: channel.stream === true,
        timeoutMs: Number(imageRuntime.timeoutMs) || 300000,
        event: context.e,
        purpose: "image-generation",
        source: "tool",
        taskName,
        trace: context.observability?.trace || null,
        parentToolId: text(context.observability?.toolCallId),
        metadata: {
          referenceCount: references.length,
          multiImageAllowed,
          ...(requestedCount === undefined ? {} : { requestedCount }),
          ...(size ? { size } : {}),
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(imageSize ? { imageSize } : {}),
          model: channel.model,
          adapter: channel.type,
        },
      })
      const generationDurationMs = Math.max(0, Date.now() - generationStartedAt)
      const outputLimit = multiImageAllowed ? maxCount : 1
      const images = outputLimit > 0 ? result.images.slice(0, outputLimit) : result.images
      if (!images.length) throw new Error("图片模型未返回图片")
      const imageBuilder = new MessageChainBuilder()
      for (const [index, image] of images.entries()) {
        const resource = resourceForImage(image, index)
        if (resource) imageBuilder.image(resource)
      }
      const imageParts = imageBuilder.build()
      if (!imageParts.length) throw new Error("图片模型返回了无法投递的结果")
      const modelName = text(channel.model).trim() || text(channel.id).trim() || "unknown"
      const builder = new MessageChainBuilder()
      builder.text(`✅ 图片生成完成（${(generationDurationMs / 1000).toFixed(2)}s）\n🤖 模型：${modelName}`)
      builder.concat(imageParts)
      const chain = builder.build()
      const delivery = canDeliverToCurrentChat(context)
        ? await sendWithMessageTool(chain, context, "complete")
        : { status: "generated", partCount: chain.length, sentCount: 0, failedCount: 0 }
      const imageCount = chain.filter(part => part.type === "image").length
      return {
        status: "success",
        content: delivery.status === "generated"
          ? `图片生成完成（${imageCount} 张，当前没有可投递的会话）。`
          : `图片生成完成并已发送（${imageCount} 张）。`,
        executedCount: 1,
        retryAllowed: false,
        metadata: {
          background: true,
          imageCount,
          upstreamImageCount: result.images.length,
          durationMs: generationDurationMs,
          referenceCount: references.length,
          model: channel.model,
          adapter: channel.type,
          deliveryStatus: delivery.status,
          sentCount: delivery.sentCount,
        },
      }
    } catch (error) {
      const message = imageErrorText(error)
      await sendFailureNotice(`图片生成失败：${message}`, context)
      throw error
    }
  }
}
