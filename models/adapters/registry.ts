import crypto from "node:crypto"
import { configStore } from "../../config/store.js"
import { ClaudeAdapter } from "./claude.js"
import { GeminiAdapter, GeminiImagesAdapter } from "./gemini.js"
import { MockAdapter } from "./mock.js"
import { ChatGLMAdapter, OpenAICompatibleAdapter, OpenAIImagesAdapter, QwenAdapter } from "./openai/chat/adapter.js"
import { OpenAIResponsesAdapter } from "./openai/responses/adapter.js"
import { toolsForResponses } from "./openai/responses/tool-adapter.js"
import { normalizeListedModels } from "./base.js"
import { normalizeModelResponse } from "../protocol/normalize.js"
import { modelLogStore } from "../../core/observability/model-log.js"
import { createMediaThumbnail } from "../../core/media/media-cache.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import type { EmbeddingRequest, ImageGenerationRequest, ImageGenerationResponse, ModelChannel, ModelListRequest, ModelMessage, ModelRequest, ModelResponse, ModelToolChoice } from "../protocol/types.js"
import type { ListedModel } from "./base.js"
import type { ToolDefinition } from "../../tools/support/tool-contract.js"

interface RuntimeModelRequest extends ModelRequest {
  event?: unknown
}

interface RuntimeEmbeddingRequest extends EmbeddingRequest {
  event?: unknown
  purpose?: string
  source?: string
  taskName?: string
  trace?: unknown
  parentToolId?: string
  metadata?: Record<string, unknown>
}

interface RuntimeAdapter {
  readonly id: string
  readonly protocol: string
  readonly supportsTools: boolean
  readonly supportsVision: boolean
  readonly supportsStreaming: boolean
  readonly supportsEmbeddings: boolean
  readonly supportsImageGeneration: boolean
  readonly supportsNativeToolSearch: boolean
  sendMessage(request: RuntimeModelRequest): Promise<ModelResponse>
  embedTexts(request: RuntimeEmbeddingRequest): Promise<Awaited<ReturnType<import("../protocol/adapter.js").ModelAdapter["embedTexts"]>>>
  generateImages?(request: ImageGenerationRequest): Promise<ImageGenerationResponse>
  listModels?(request?: ModelListRequest): Promise<unknown[]>
}

interface ModelSendOptions {
  channel?: ModelChannel
  messages?: ModelMessage[]
  replayMessages?: ModelMessage[]
  tools?: ToolDefinition[]
  toolChoice?: ModelToolChoice
  maxTokens?: number
  signal?: AbortSignal
  event?: unknown
  purpose?: string
  source?: string
  taskName?: string
  operation?: string
  trace?: unknown
  parentToolId?: string
  metadata?: Record<string, unknown>
  snapshotMetadata?: Record<string, unknown>
}

interface EmbeddingSendOptions {
  channel?: ModelChannel
  texts?: string[]
  dimensions?: number
  signal?: AbortSignal
  event?: unknown
  purpose?: string
  source?: string
  taskName?: string
  trace?: unknown
  parentToolId?: string
  metadata?: Record<string, unknown>
}

interface ImageSendOptions {
  channel?: ModelChannel
  prompt?: string
  references?: ImageGenerationRequest["references"]
  count?: number
  size?: string
  quality?: string
  aspectRatio?: string
  imageSize?: string
  background?: string
  stream?: boolean
  timeoutMs?: number
  signal?: AbortSignal
  event?: unknown
  purpose?: string
  source?: string
  taskName?: string
  trace?: unknown
  parentToolId?: string
  metadata?: Record<string, unknown>
}

interface ChannelTestResult {
  channel?: string
  adapter: string
  operation: "chat" | "embedding" | "image"
  text: string
  dimensions?: number
  vectorCount?: number
}

function record(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isEmbeddingChannel(channel: ModelChannel): boolean {
  return record(record(channel.modelConfig).capabilities).embedding === true
}

function isImageChannel(channel: ModelChannel): boolean {
  const modelConfig = record(channel.modelConfig)
  return String(modelConfig.purpose || "") === "image" || ["openai-images", "openai-chat-completions", "gemini-images"].includes(String(channel.type || ""))
}

function unknownImageUsage() {
  return { input: 0, output: 0, total: 0, cached: 0, reasoning: 0, source: "unknown" as const, inputKnown: false, outputKnown: false }
}

/**
 * 供应商适配器注册表，负责实例生命周期、统一观测和协议边界。
 *
 * 它不参与模型选择、不决定工具权限；这些职责分别由路由和工具运行时承担。
 */
export class AdapterRegistry {
  readonly adapters = new Map<string, RuntimeAdapter>()

  constructor() {
    this.register(new MockAdapter())
    this.register(new OpenAICompatibleAdapter())
    this.register(new OpenAIImagesAdapter())
    this.register(new OpenAIResponsesAdapter())
    this.register(new GeminiAdapter())
    this.register(new GeminiImagesAdapter())
    this.register(new QwenAdapter())
    this.register(new ClaudeAdapter())
    this.register(new ChatGLMAdapter())
  }

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(type = ""): RuntimeAdapter {
    return this.adapters.get(type) || this.adapters.get("mock") as RuntimeAdapter
  }

  listAdapters(): Array<Pick<RuntimeAdapter, "id" | "protocol" | "supportsTools" | "supportsVision" | "supportsStreaming" | "supportsEmbeddings" | "supportsImageGeneration" | "supportsNativeToolSearch">> {
    return [...this.adapters.values()].map(adapter => ({
      id: adapter.id,
      protocol: adapter.protocol,
      supportsTools: adapter.supportsTools,
      supportsVision: adapter.supportsVision,
      supportsStreaming: adapter.supportsStreaming,
      supportsEmbeddings: adapter.supportsEmbeddings,
      supportsImageGeneration: adapter.supportsImageGeneration,
      supportsNativeToolSearch: adapter.supportsNativeToolSearch,
    }))
  }

  async sendMessage({ channel, messages = [], replayMessages, tools = [], toolChoice, maxTokens = 0, signal, event, purpose = "chat", source = "", taskName = "", operation = "chat", trace = null, parentToolId = "", metadata = {}, snapshotMetadata = {} }: ModelSendOptions = {}): Promise<ModelResponse> {
    if (!channel) throw new Error("channel is required")
    const adapter = this.get(channel.type)
    const modelVisibleTools = adapter.supportsNativeToolSearch ? toolsForResponses(tools, channel) : tools
    const call = modelLogStore.beginModelCall({ trace, event, source, purpose, taskName, operation, channel, messages, tools: modelVisibleTools, parentToolId, metadata, snapshotMetadata, request: { maxTokens, toolChoice, protocol: adapter.protocol } })
    try {
      const result = normalizeModelResponse(await adapter.sendMessage({ channel, messages, replayMessages, tools, toolChoice, maxTokens, signal, event, onRequest: capture => modelLogStore.captureModelRequest(call, capture) }))
      modelLogStore.completeModelCall(call, { response: result })
      return result
    } catch (error) {
      modelLogStore.completeModelCall(call, { error })
      throw error
    }
  }

  async embedTexts({ channel, texts = [], dimensions = 0, signal, event, purpose = "embedding", source = "embedding", taskName = "", trace = null, parentToolId = "", metadata = {} }: EmbeddingSendOptions = {}): Promise<Awaited<ReturnType<RuntimeAdapter["embedTexts"]>>> {
    if (!channel) throw new Error("channel is required")
    const adapter = this.get(channel.type)
    const call = modelLogStore.beginModelCall({ trace, event, source, purpose, taskName, operation: "embedding", channel, texts, parentToolId, metadata, request: { dimensions, protocol: adapter.protocol } })
    try {
      const result = await adapter.embedTexts({ channel, texts, dimensions, signal, event, purpose, source, taskName, trace, parentToolId, metadata, onRequest: capture => modelLogStore.captureModelRequest(call, capture) })
      modelLogStore.completeModelCall(call, { response: result })
      return result
    } catch (error) {
      modelLogStore.completeModelCall(call, { error })
      throw error
    }
  }

  /** 统一图片生成入口；参考图只进入适配器请求，日志中保留数量和尺寸等摘要。 */
  async generateImages({ channel, prompt = "", references = [], count, size = "", quality = "", aspectRatio = "", imageSize = "", background = "", stream: requestedStream, timeoutMs, signal, event, purpose = "image-generation", source = "tool", taskName = "imageGeneration", trace = null, parentToolId = "", metadata = {} }: ImageSendOptions = {}): Promise<ImageGenerationResponse> {
    if (!channel) throw new Error("channel is required")
    // Chat Completions 图片模型沿用 OpenAI 图片适配器的实现，但保留
    // channel.image.protocol 以便在适配器内部选择 /chat/completions 端点。
    const requestedAdapter = channel.type === "openai-chat-completions" ? this.get("openai-images") : this.get(channel.type)
    const adapter = requestedAdapter.supportsImageGeneration && requestedAdapter.generateImages
      ? requestedAdapter
        : ["openai-compatible", "qwen", "chatglm", "openai-responses", "claude"].includes(requestedAdapter.id)
        ? this.get("openai-images")
        : requestedAdapter.id === "gemini" ? this.get("gemini-images") : requestedAdapter
    if (!adapter.generateImages) throw new Error(`${adapter.id} adapter does not support image generation`)
    const safeReferences = Array.isArray(references) ? references.slice(0, 3) : []
    const hasExplicitCount = count !== undefined && count !== null && Number.isFinite(Number(count))
    const safeCount = hasExplicitCount ? Math.max(1, Math.trunc(Number(count))) : undefined
    const stream = requestedStream === undefined ? channel.stream === true : requestedStream === true
    const messages: ModelMessage[] = [{ role: "user", content: `${prompt}${safeReferences.length ? `\n[参考图 ${safeReferences.length} 张]` : ""}` }]
    const call = modelLogStore.beginModelCall({
      trace,
      event,
      source,
      purpose,
      taskName,
      operation: "image-generation",
      channel,
      messages,
      tools: [],
      parentToolId,
      metadata: {
        ...metadata,
        imageGeneration: true,
        referenceCount: safeReferences.length,
        ...(safeCount === undefined ? {} : { requestedCount: safeCount }),
        stream,
      },
      request: {
        protocol: adapter.protocol,
        ...(safeCount === undefined ? {} : { count: safeCount }),
        size,
        quality,
        aspectRatio,
        imageSize,
        background,
        stream,
        timeoutMs,
        referenceCount: safeReferences.length,
      },
    })
    try {
      const generated = await adapter.generateImages({ channel, prompt, references: safeReferences, count: safeCount, size, quality, aspectRatio, imageSize, background, stream, timeoutMs, signal, onRequest: capture => modelLogStore.captureModelRequest(call, capture) })
      const result = { ...generated, images: generated.images }
      const currentConfig = configStore.get()
      const renderConfig = record(record(currentConfig.response).render)
      const thumbnailConfig = record(renderConfig.mediaThumbnail)
      const maxThumbnailCount = renderConfig.mediaThumbnails === false || thumbnailConfig.enabled === false
        ? 0
        : Math.max(0, Math.min(6, Math.trunc(Number(renderConfig.mediaThumbnailMaxCount) || 3)))
      const maxThumbnailChars = Math.max(1000, Math.min(4000000, Math.trunc(Number(renderConfig.mediaThumbnailMaxDataUrlChars) || 800000)))
      const thumbnailSources = result.images.slice(0, maxThumbnailCount).map(image => image.data || image.url)
      modelLogStore.completeModelCall(call, { response: { id: crypto.randomUUID(), text: `图片生成完成（${result.images.length} 张）`, toolCalls: [], stopReason: "end_turn", usage: result.usage || unknownImageUsage() } })
      // 缩略图不阻塞图片投递，生成后只写入按需读取的模型详情快照。
      void Promise.all(thumbnailSources.map(source => createMediaThumbnail(source, currentConfig)))
        .then(values => modelLogStore.captureModelResponseMedia(call, values.filter(value => value && value.length <= maxThumbnailChars), result.images.length))
        .catch(() => hostRuntime.logger?.warn?.("[yui-chat] 生成日志缩略图失败"))
      return result
    } catch (error) {
      modelLogStore.completeModelCall(call, { error })
      throw error
    }
  }

  async testChannel(channel: ModelChannel): Promise<ChannelTestResult> {
    const adapter = channel.type === "openai-chat-completions" ? this.get("openai-images") : this.get(channel.type)
    if (isImageChannel(channel)) return { channel: channel.id, adapter: adapter.id, operation: "image", text: "图片模型已配置，未发起生成请求" }
    if (isEmbeddingChannel(channel)) {
      const result = await this.embedTexts({ channel, texts: ["embedding health check"], purpose: "model-test", source: "management", taskName: "channel-test" })
      const firstVector = result.vectors[0]
      if (!Array.isArray(firstVector) || !firstVector.length) throw new Error("embedding 未返回有效向量")
      return {
        channel: channel.id,
        adapter: adapter.id,
        operation: "embedding",
        text: `embedding 测试通过：${firstVector.length} 维`,
        dimensions: result.dimensions || firstVector.length,
        vectorCount: result.vectors.length,
      }
    }
    const testChannel = adapter.supportsNativeToolSearch
      ? { ...channel, responsesRuntime: { toolSearchAllowed: false, webSearchAllowed: false, fileSearchAllowed: false } }
      : channel
    const result = await this.sendMessage({ channel: testChannel, messages: [{ role: "user", content: "health check" }], tools: [], purpose: "model-test", source: "management", taskName: "channel-test" })
    return { channel: channel.id, adapter: adapter.id, operation: "chat", text: result.text }
  }

  async listModels(channel: ModelChannel): Promise<{ channel?: string; adapter: string; models: ListedModel[] }> {
    const adapter = channel.type === "openai-chat-completions" ? this.get("openai-images") : this.get(channel.type)
    if (!adapter.listModels) throw new Error(`${adapter.id} adapter does not support model listing`)
    const models = await adapter.listModels({ channel })
    return { channel: channel.id, adapter: adapter.id, models: normalizeListedModels(models) }
  }
}

export { messagesToGeminiContents, parseGeminiToolCalls, parseGeminiImageStreamResponse, parseGeminiStreamResponse } from "./gemini.js"
export { messagesToClaudeMessages, parseClaudeToolCalls, parseClaudeStreamResponse } from "./claude.js"
export { parseResponsesStreamResponse } from "./openai/responses/response-adapter.js"
export { parseOpenAIImageStreamResponse } from "./openai/chat/adapter.js"
export const adapterRegistry = new AdapterRegistry()
