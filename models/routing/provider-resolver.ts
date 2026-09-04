import { configStore } from "../../config/store.js"
import type { RuntimeConfigObject } from "../../config/types.js"
import { isJsonValue, type JsonValue } from "../../core/message-chain/types.js"
import type { ModelChannel } from "../protocol/types.js"
import { describeReasoning, normalizeReasoningConfig } from "../configuration/reasoning.js"

type UnknownRecord = Record<string, unknown>
type RoutingConfigInput = RuntimeConfigObject | UnknownRecord | RoutingConfig | undefined

interface ProviderConfig extends UnknownRecord {
  name?: string
  id?: string
  type?: string
  baseURL?: string
  apiKey?: string
  authType?: string
  authHeader?: string
  timeoutMs?: unknown
  stream?: unknown
  headers?: UnknownRecord
  query?: UnknownRecord
  params?: UnknownRecord
}

interface ModelConfig extends UnknownRecord {
  name?: string
  adapter?: string
  modelIdentifier?: string
  model?: string
  apiProvider?: string
  baseURL?: string
  apiKey?: string
  authType?: string
  authHeader?: string
  visual?: unknown
  toolUse?: unknown
  stream?: unknown
  timeoutMs?: unknown
  reasoning?: unknown
  params?: UnknownRecord
  headers?: UnknownRecord
  query?: UnknownRecord
  capabilities?: UnknownRecord
  embedding?: UnknownRecord
  toolPolicy?: UnknownRecord
}

interface ModelTask extends UnknownRecord {
  modelList?: unknown[]
  selectionStrategy?: string
  maxTokens?: unknown
  temperature?: unknown
}

interface ChannelConfig extends UnknownRecord {
  id?: string
  name?: string
  type?: string
  enabled?: unknown
  model?: string
  apiProvider?: string
  provider?: string
  baseURL?: string
  apiKey?: string
  authType?: string
  authHeader?: string
  stream?: unknown
  timeoutMs?: unknown
  headers?: UnknownRecord
  query?: UnknownRecord
  params?: UnknownRecord
  toolUse?: unknown
  reasoning?: unknown
}

interface ChatConfig extends UnknownRecord {
  defaultTask?: string
  modelRequestTimeoutMs?: unknown
  modelStream?: unknown
}

interface RoutingConfig {
  apiProviders: ProviderConfig[]
  models: ModelConfig[]
  modelTasks: Record<string, ModelTask>
  channels: ChannelConfig[]
  chat: ChatConfig
  mediaRecognition: UnknownRecord
}

/** 路由后的模型渠道；额外字段仅用于日志、管理台摘要和适配器请求。 */
export interface ResolvedModelChannel extends ModelChannel {
  id: string
  name: string
  origin: "model" | "channel"
  enabled: boolean
  provider?: ProviderConfig | string
  modelConfig?: Record<string, JsonValue>
}

export interface RoutingIssue {
  level: "error" | "warn"
  area: string
  id?: string
  message: string
}

interface ResolveOptions {
  taskName?: string
  channelId?: string
  config?: RoutingConfigInput
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function taskRecords(value: unknown): Record<string, ModelTask> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, record(item) as ModelTask]))
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (value) return text(value)
  }
  return ""
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(record(value))) {
    if (isJsonValue(item)) result[key] = item
  }
  return result
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function viewOf(config: RoutingConfigInput): RoutingConfig {
  const root = record(config)
  return {
    apiProviders: records(root.apiProviders) as ProviderConfig[],
    models: records(root.models) as ModelConfig[],
    modelTasks: taskRecords(root.modelTasks),
    channels: records(root.channels) as ChannelConfig[],
    chat: record(root.chat) as ChatConfig,
    mediaRecognition: record(root.mediaRecognition),
  }
}

function selectionStrategy(task: ModelTask): string {
  return text(task.selectionStrategy) || "sequential"
}

function mockModel(): ModelConfig {
  return { name: "mock", adapter: "mock", modelIdentifier: "mock", apiProvider: "mock" }
}

function capabilities(model: ModelConfig): UnknownRecord {
  return record(model.capabilities)
}

function embeddingConfig(model: ModelConfig): UnknownRecord {
  return record(model.embedding)
}

function providerLabel(provider: ProviderConfig | string | undefined): string {
  if (typeof provider === "string") return provider
  return text(provider?.name || provider?.id)
}

function modelPreview(model: ModelConfig, channel: ResolvedModelChannel): Record<string, unknown> {
  return {
    name: text(model.name),
    provider: text(model.apiProvider),
    adapter: channel.type,
    modelIdentifier: channel.model,
    baseURL: channel.baseURL,
    hasApiKey: Boolean(channel.apiKey),
    visual: Boolean(model.visual),
    toolUse: model.toolUse !== false,
    chat: capabilities(model).chat !== false,
    embedding: Boolean(capabilities(model).embedding),
    embeddingDimensions: numberValue(embeddingConfig(model).defaultDimensions, 0),
    reasoning: channel.reasoning || null,
    reasoningLabel: describeReasoning(channel),
    timeoutMs: channel.timeoutMs,
    stream: Boolean(channel.stream),
  }
}

const streamingAdapterIds = new Set(["openai-compatible", "qwen", "chatglm"])

/**
 * 模型路由器：只负责把任务配置解析成可执行渠道，不负责发起请求或决定工具权限。
 *
 * 配置从文件、SQLite 和管理台进入这里时都视为 unknown；viewOf 会先筛掉非对象
 * 结构，再由本模块的领域类型承载后续逻辑。这样供应商新增字段不会把不安全的动态
 * 数据扩散到适配器之外，也避免在每个调用方重复做一套配置解析。
 */
export class ProviderResolver {
  private readonly cursors = new Map<string, number>()

  private getCursor(key: string): number {
    const value = this.cursors.get(key) || 0
    this.cursors.set(key, value + 1)
    return value
  }

  pickModel(taskName = "", config: RoutingConfigInput = {}): ModelConfig {
    const channel = this.resolveCandidateChannels({ taskName, config })[0]
    if (channel?.modelConfig) return channel.modelConfig as ModelConfig
    if (channel) {
      return {
        name: channel.id,
        adapter: channel.type,
        modelIdentifier: channel.model,
        apiProvider: firstText(providerLabel(channel.provider), channel.apiProvider, channel.id),
      }
    }
    return viewOf(config).models[0] || mockModel()
  }

  pickModelFromTask(taskName = "", config: RoutingConfigInput = {}): ModelConfig {
    const view = viewOf(config)
    const task = this.getTask(taskName, view)
    const list = arrayOfStrings(task.modelList)
    const enabledModels = (list.length ? list : ["mock"])
      .map(name => view.models.find(model => text(model.name) === name))
      .filter((model): model is ModelConfig => Boolean(model))
    if (!enabledModels.length) return view.models[0] || mockModel()

    if (selectionStrategy(task) === "random") {
      return enabledModels[Math.floor(Math.random() * enabledModels.length)]
    }
    return enabledModels[this.getCursor(taskName) % enabledModels.length]
  }

  buildChannel(model: ModelConfig, config: RoutingConfigInput = {}): ResolvedModelChannel {
    const view = viewOf(config)
    const provider = view.apiProviders.find(item => text(item.name) === text(model.apiProvider)) || {}
    const reasoning = normalizeReasoningConfig(model.reasoning)
    const type = firstText(model.adapter, provider.type, "mock")
    const params: UnknownRecord = {
      ...record(provider.params),
      ...record(model.params),
    }
    // timeoutMs/stream 属于渠道行为配置，不透传给供应商请求参数。
    delete params.timeoutMs
    delete params.stream
    const timeoutMs = numberValue(
      model.timeoutMs ?? provider.timeoutMs ?? view.chat.modelRequestTimeoutMs,
      90000,
    )
    const stream = streamingAdapterIds.has(type) && Boolean(
      model.stream ?? provider.stream ?? view.chat.modelStream ?? false,
    )
    return {
      id: text(model.name),
      name: text(model.name),
      origin: "model",
      type,
      enabled: true,
      model: firstText(model.modelIdentifier, model.model, model.name),
      baseURL: firstText(model.baseURL, provider.baseURL),
      apiKey: firstText(model.apiKey, provider.apiKey),
      authType: firstText(model.authType, provider.authType, "bearer"),
      authHeader: firstText(model.authHeader, provider.authHeader, "Authorization"),
      headers: { ...record(provider.headers), ...record(model.headers) },
      query: { ...record(provider.query), ...record(model.query) },
      params,
      timeoutMs: Math.max(1000, Math.min(600000, Number.isFinite(timeoutMs) ? timeoutMs : 90000)),
      stream: Boolean(stream),
      reasoning,
      provider,
      modelConfig: jsonRecord(model),
    }
  }

  getTask(taskName = "", config: RoutingConfigInput = {}): ModelTask {
    const view = viewOf(config)
    return view.modelTasks[taskName]
      || view.modelTasks[text(view.chat.defaultTask)]
      || {}
  }

  getConfiguredChannel(channelId: string, config: RoutingConfigInput = {}): ResolvedModelChannel | null {
    const view = viewOf(config)
    const channel = view.channels.find(item => text(item.id) === channelId && Boolean(item.enabled))
    if (!channel) return null
    const params: UnknownRecord = { ...record(channel.params) }
    const timeoutMs = numberValue(
      channel.timeoutMs ?? params.timeoutMs ?? view.chat.modelRequestTimeoutMs,
      90000,
    )
    const type = text(channel.type)
    const stream = streamingAdapterIds.has(type) && Boolean(
      channel.stream ?? params.stream ?? view.chat.modelStream ?? false,
    )
    delete params.timeoutMs
    delete params.stream
    return {
      ...channel,
      id: text(channel.id),
      name: firstText(channel.name, channel.id),
      type,
      model: firstText(channel.model, channel.id),
      params,
      timeoutMs: Math.max(1000, Math.min(600000, Number.isFinite(timeoutMs) ? timeoutMs : 90000)),
      stream,
      origin: "channel",
      enabled: channel.enabled !== false,
    }
  }

  resolveCandidateChannels(options: ResolveOptions = {}): ResolvedModelChannel[] {
    const view = viewOf(options.config)
    if (options.channelId) {
      const configuredChannel = this.getConfiguredChannel(options.channelId, view)
      if (configuredChannel) return [configuredChannel]
      const model = view.models.find(item => text(item.name) === options.channelId)
      if (model) return [this.buildChannel(model, view)]
    }

    const name = options.taskName || text(view.chat.defaultTask)
    const task = this.getTask(name, view)
    const list = arrayOfStrings(task.modelList)
    const channels = (list.length ? list : ["mock"])
      .map(modelId => view.models.find(model => text(model.name) === modelId))
      .filter((model): model is ModelConfig => Boolean(model))
      .map(model => this.buildChannel(model, view))
    if (!channels.length && view.models[0]) return [this.buildChannel(view.models[0], view)]
    if (!channels.length) return [this.buildChannel(mockModel(), view)]

    if (selectionStrategy(task) === "random") {
      return [channels[Math.floor(Math.random() * channels.length)]]
    }
    if (selectionStrategy(task) === "fallback") return channels

    return [channels[this.getCursor(name) % channels.length]]
  }

  async resolve(options: Omit<ResolveOptions, "config"> = {}): Promise<ResolvedModelChannel | undefined> {
    const config = await configStore.load()
    return this.resolveCandidateChannels({ ...options, config })[0]
  }

  async resolveCandidates(options: Omit<ResolveOptions, "config"> = {}): Promise<ResolvedModelChannel[]> {
    const config = await configStore.load()
    return this.resolveCandidateChannels({ ...options, config })
  }

  async listResolvedModels(): Promise<ResolvedModelChannel[]> {
    const config = await configStore.load()
    const view = viewOf(config)
    return view.models.map(model => this.buildChannel(model, view))
  }

  async listChannels(): Promise<Array<Record<string, unknown>>> {
    const config = await configStore.load()
    const view = viewOf(config)
    const modern = view.models.map(model => this.buildChannel(model, view))
    const configured = view.channels
      .map(channel => this.getConfiguredChannel(text(channel.id), view))
      .filter((channel): channel is ResolvedModelChannel => Boolean(channel))
    return [...modern, ...configured].map(channel => {
      const model = record(channel.modelConfig)
      const modelCapabilities = record(model.capabilities)
      const embedding = record(model.embedding)
      return {
        id: channel.id,
        name: channel.name,
        origin: channel.origin || "model",
        type: channel.type,
        model: channel.model,
        enabled: channel.enabled !== false,
        hasApiKey: Boolean(channel.apiKey),
        baseURL: channel.baseURL,
        provider: firstText(providerLabel(channel.provider), model.apiProvider),
        visual: model.visual,
        toolUse: model.toolUse,
        chat: modelCapabilities.chat !== false,
        embedding: Boolean(modelCapabilities.embedding),
        embeddingDimensions: numberValue(embedding.defaultDimensions, 0),
        reasoning: channel.reasoning || null,
        reasoningLabel: describeReasoning(record(channel)),
        timeoutMs: channel.timeoutMs,
        stream: Boolean(channel.stream),
      }
    })
  }

  buildTaskPreview(config: RoutingConfigInput = {}, taskName = ""): Record<string, unknown> {
    const view = viewOf(config)
    const name = taskName || text(view.chat.defaultTask) || "replyer"
    const issues: RoutingIssue[] = []
    const task = view.modelTasks[name]
    if (!task) issues.push({ level: "error", area: "modelTasks", id: name, message: `任务 ${name} 不存在` })
    const modelList = arrayOfStrings(task?.modelList)
    if (!modelList.length) issues.push({ level: "warn", area: "modelTasks", id: name, message: `任务 ${name} 没有 modelList` })
    const candidates: Array<Record<string, unknown>> = modelList.map(modelId => {
      const model = view.models.find(item => text(item.name) === modelId)
      if (!model) {
        issues.push({ level: "error", area: "models", id: modelId, message: `任务 ${name} 引用了不存在的模型` })
        return { name: modelId, missing: true }
      }
      return modelPreview(model, this.buildChannel(model, view))
    })
    const recognitionModel = text(view.mediaRecognition.recognitionModel).trim()
    const recognition = recognitionModel
      ? candidates.find(item => text(item.name) === recognitionModel)
        || this.buildMediaRecognitionPreview(view, recognitionModel, issues)
      : null
    const strategy = selectionStrategy(task || {})
    return {
      ok: !issues.some(issue => issue.level === "error"),
      task: name,
      selectionStrategy: strategy,
      maxTokens: task?.maxTokens,
      temperature: task?.temperature,
      candidateCount: candidates.length,
      candidates,
      selected: candidates.find(model => model.missing !== true) || null,
      fallbackEnabled: strategy === "fallback",
      mediaRecognition: {
        enabled: view.mediaRecognition.enabled !== false,
        recognitionModel,
        selected: recognition,
      },
      issues,
    }
  }

  private buildMediaRecognitionPreview(
    config: RoutingConfigInput,
    modelId: string,
    issues: RoutingIssue[] = [],
  ): Record<string, unknown> {
    const view = viewOf(config)
    const model = view.models.find(item => text(item.name) === modelId)
    if (model) return modelPreview(model, this.buildChannel(model, view))

    const channel = view.channels.find(item => text(item.id) === modelId && item.enabled !== false)
    if (channel) {
      return {
        name: text(channel.id),
        provider: firstText(channel.apiProvider, channel.provider),
        adapter: text(channel.type),
        modelIdentifier: text(channel.model),
        baseURL: text(channel.baseURL),
        hasApiKey: Boolean(channel.apiKey),
        visual: true,
        toolUse: channel.toolUse !== false,
        reasoning: normalizeReasoningConfig(channel.reasoning),
        reasoningLabel: describeReasoning(record(channel)),
      }
    }
    issues.push({ level: "error", area: "mediaRecognition", id: modelId, message: `媒体识别增强模型不存在：${modelId}` })
    return { name: modelId, missing: true }
  }

  buildRoutingDigest(config: RoutingConfigInput = {}): Record<string, unknown> {
    const view = viewOf(config)
    const providerUsage: Record<string, {
      name: string
      type: string
      modelCount: number
      taskCount: number
      hasApiKey: boolean
      baseURL: string
    }> = {}
    for (const provider of view.apiProviders) {
      const name = text(provider.name)
      providerUsage[name] = {
        name,
        type: firstText(provider.type, "unknown"),
        modelCount: 0,
        taskCount: 0,
        hasApiKey: Boolean(provider.apiKey),
        baseURL: text(provider.baseURL),
      }
    }

    const taskRows: Array<Record<string, unknown>> = []
    for (const [taskName, task] of Object.entries(view.modelTasks)) {
      const taskModels = arrayOfStrings(task.modelList)
        .map(modelId => view.models.find(model => text(model.name) === modelId))
        .filter((model): model is ModelConfig => Boolean(model))
      const providersInTask = [...new Set(taskModels.map(model => text(model.apiProvider)).filter(Boolean))]
      for (const providerName of providersInTask) {
        if (providerUsage[providerName]) providerUsage[providerName].taskCount++
      }
      taskRows.push({
        name: taskName,
        selectionStrategy: selectionStrategy(task),
        modelCount: taskModels.length,
        models: taskModels.map(model => text(model.name)),
        providers: providersInTask,
        visualModels: taskModels.filter(model => Boolean(model.visual)).length,
        toolUseModels: taskModels.filter(model => model.toolUse !== false).length,
      })
    }
    for (const model of view.models) {
      const provider = providerUsage[text(model.apiProvider)]
      if (provider) provider.modelCount++
    }
    const defaultTask = text(view.chat.defaultTask)
    const defaultPreview = this.buildTaskPreview(view, defaultTask)
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        providers: view.apiProviders.length,
        models: view.models.length,
        tasks: taskRows.length,
        defaultTask,
        defaultTaskOk: defaultPreview.ok,
        fallbackTasks: taskRows.filter(item => item.selectionStrategy === "fallback").length,
        visualModels: view.models.filter(model => Boolean(model.visual)).length,
        toolUseModels: view.models.filter(model => model.toolUse !== false).length,
        embeddingModels: view.models.filter(model => Boolean(capabilities(model).embedding)).length,
      },
      providerUsage: Object.values(providerUsage),
      tasks: taskRows,
      defaultPreview,
    }
  }

  validateConfig(config: RoutingConfigInput = {}, adapterIds: readonly string[] = []): { ok: boolean; issues: RoutingIssue[] } {
    const view = viewOf(config)
    const issues: RoutingIssue[] = []
    const providerNames = new Set(view.apiProviders.map(item => text(item.name)))
    const modelNames = new Set(view.models.map(item => text(item.name)))
    const adapterSet = new Set(adapterIds.map(text))
    const authTypes = new Set(["bearer", "none", "query", "x-api-key", "api-key", "custom-header"])

    for (const provider of view.apiProviders) {
      const name = text(provider.name)
      const type = text(provider.type)
      const authType = text(provider.authType)
      if (!name) issues.push({ level: "error", area: "apiProviders", message: "存在未命名 provider" })
      if (!type) issues.push({ level: "warn", area: "apiProviders", id: name, message: "provider 未声明 type，将依赖模型 adapter 或 mock" })
      else if (adapterSet.size && !adapterSet.has(type)) issues.push({ level: "warn", area: "apiProviders", id: name, message: `provider type ${type} 没有对应适配器` })
      if (authType && !authTypes.has(authType)) issues.push({ level: "warn", area: "apiProviders", id: name, message: `未知 authType：${authType}` })
      if (authType !== "none" && name !== "mock" && !provider.apiKey) issues.push({ level: "warn", area: "apiProviders", id: name, message: "provider 未配置 apiKey；如果是本地接口请设置 authType=none" })
    }

    for (const model of view.models) {
      const name = text(model.name)
      const providerName = text(model.apiProvider)
      const adapter = firstText(model.adapter, view.apiProviders.find(item => text(item.name) === providerName)?.type)
      if (!name) issues.push({ level: "error", area: "models", message: "存在未命名 model" })
      if (providerName && !providerNames.has(providerName)) issues.push({ level: "error", area: "models", id: name, message: `模型引用了不存在的 provider：${providerName}` })
      if (adapterSet.size && adapter && !adapterSet.has(adapter)) issues.push({ level: "warn", area: "models", id: name, message: `模型 adapter ${adapter} 没有对应适配器` })
      if (!model.modelIdentifier && !model.model) issues.push({ level: "warn", area: "models", id: name, message: "模型未声明 modelIdentifier" })
    }

    for (const [taskName, task] of Object.entries(view.modelTasks)) {
      const list = arrayOfStrings(task.modelList)
      if (!list.length) issues.push({ level: "warn", area: "modelTasks", id: taskName, message: "任务没有 modelList" })
      for (const modelId of list) {
        if (!modelNames.has(modelId)) issues.push({ level: "error", area: "modelTasks", id: taskName, message: `任务引用了不存在的模型：${modelId}` })
      }
      if (task.selectionStrategy && !["sequential", "random", "fallback"].includes(text(task.selectionStrategy))) {
        issues.push({ level: "warn", area: "modelTasks", id: taskName, message: `未知 selectionStrategy：${text(task.selectionStrategy)}` })
      }
    }
    return { ok: !issues.some(issue => issue.level === "error"), issues }
  }

  async diagnostics(adapterIds: readonly string[] = []): Promise<Record<string, unknown>> {
    const config = await configStore.load()
    const view = viewOf(config)
    const defaultTask = text(view.chat.defaultTask)
    return {
      validation: this.validateConfig(view, adapterIds),
      channels: await this.listChannels(),
      defaultTask,
      routingPreview: this.buildTaskPreview(view, defaultTask),
      routingDigest: this.buildRoutingDigest(view),
    }
  }
}

export const providerResolver = new ProviderResolver()
