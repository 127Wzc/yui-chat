import { ClaudeAdapter, messagesToClaudeMessages, parseClaudeToolCalls } from "./claude.js"
import { GeminiAdapter, messagesToGeminiContents, parseGeminiToolCalls } from "./gemini.js"
import { MockAdapter } from "./mock.js"
import { ChatGLMAdapter, OpenAICompatibleAdapter, QwenAdapter } from "./openai-compatible.js"
import { normalizeListedModels } from "./base.js"
import { normalizeModelResponse } from "../protocol/normalize.js"
import { modelLogStore } from "../../core/observability/model-log.js"
import type { EmbeddingRequest, ModelChannel, ModelListRequest, ModelMessage, ModelRequest, ModelResponse, ModelToolChoice } from "../protocol/types.js"
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
  readonly supportsTools: boolean
  readonly supportsVision: boolean
  readonly supportsStreaming: boolean
  readonly supportsEmbeddings: boolean
  sendMessage(request: RuntimeModelRequest): Promise<ModelResponse>
  embedTexts(request: RuntimeEmbeddingRequest): Promise<Awaited<ReturnType<import("../protocol/adapter.js").ModelAdapter["embedTexts"]>>>
  listModels?(request?: ModelListRequest): Promise<unknown[]>
}

interface ModelSendOptions {
  channel?: ModelChannel
  messages?: ModelMessage[]
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
    this.register(new GeminiAdapter())
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

  listAdapters(): Array<Pick<RuntimeAdapter, "id" | "supportsTools" | "supportsVision" | "supportsStreaming" | "supportsEmbeddings">> {
    return [...this.adapters.values()].map(adapter => ({
      id: adapter.id,
      supportsTools: adapter.supportsTools,
      supportsVision: adapter.supportsVision,
      supportsStreaming: adapter.supportsStreaming,
      supportsEmbeddings: adapter.supportsEmbeddings,
    }))
  }

  async sendMessage({ channel, messages = [], tools = [], toolChoice, maxTokens = 0, signal, event, purpose = "chat", source = "", taskName = "", operation = "chat", trace = null, parentToolId = "", metadata = {}, snapshotMetadata = {} }: ModelSendOptions = {}): Promise<ModelResponse> {
    if (!channel) throw new Error("channel is required")
    const adapter = this.get(channel.type)
    const call = modelLogStore.beginModelCall({ trace, event, source, purpose, taskName, operation, channel, messages, tools, parentToolId, metadata, snapshotMetadata, request: { maxTokens, toolChoice } })
    try {
      const result = normalizeModelResponse(await adapter.sendMessage({ channel, messages, tools, toolChoice, maxTokens, signal, event }))
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
    const call = modelLogStore.beginModelCall({ trace, event, source, purpose, taskName, operation: "embedding", channel, texts, parentToolId, metadata, request: { dimensions } })
    try {
      const result = await adapter.embedTexts({ channel, texts, dimensions, signal, event, purpose, source, taskName, trace, parentToolId, metadata })
      modelLogStore.completeModelCall(call, { response: result })
      return result
    } catch (error) {
      modelLogStore.completeModelCall(call, { error })
      throw error
    }
  }

  async testChannel(channel: ModelChannel): Promise<{ channel?: string; adapter: string; text: string }> {
    const result = await this.sendMessage({ channel, messages: [{ role: "user", content: "health check" }], tools: [], purpose: "model-test", source: "management", taskName: "channel-test" })
    return { channel: channel.id, adapter: this.get(channel.type).id, text: result.text }
  }

  async listModels(channel: ModelChannel): Promise<{ channel?: string; adapter: string; models: ListedModel[] }> {
    const adapter = this.get(channel.type)
    if (!adapter.listModels) throw new Error(`${adapter.id} adapter does not support model listing`)
    const models = await adapter.listModels({ channel })
    return { channel: channel.id, adapter: adapter.id, models: normalizeListedModels(models) }
  }
}

export { messagesToGeminiContents, parseGeminiToolCalls, messagesToClaudeMessages, parseClaudeToolCalls }
export const adapterRegistry = new AdapterRegistry()
