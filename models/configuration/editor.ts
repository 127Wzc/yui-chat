import { sanitizeIdentifier } from "../../core/shared/identifiers.js"
import { cloneJsonValue as clone } from "../../core/shared/json-values.js"
import { getProviderTemplate, listProviderTemplates, type ProviderTemplate } from "./provider-templates.js"

type UnknownRecord = Record<string, unknown>

const unsafeConfigPathKeys = new Set(["__proto__", "prototype", "constructor"])

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function cloneRecord(value: unknown): UnknownRecord {
  return record(clone(value))
}

function configModels(config: UnknownRecord): UnknownRecord[] {
  return records(config.models)
}

function configProviders(config: UnknownRecord): UnknownRecord[] {
  return records(config.apiProviders)
}

function configTasks(config: UnknownRecord): Record<string, UnknownRecord> {
  return Object.fromEntries(Object.entries(record(config.modelTasks)).map(([key, value]) => [key, record(value)]))
}

function normalizeReasoningPatch(value: unknown, fallback: UnknownRecord | null = null): UnknownRecord | null {
  if (value === null) return null
  return isRecord(value) ? value : fallback
}

/** 管理台表单的供应商草稿只负责组合配置，不触发网络请求或保存操作。 */
export function resolveProviderDraft(body: UnknownRecord = {}, config: UnknownRecord = {}): UnknownRecord {
  const template = getProviderTemplate(body.templateId || body.template)
  const providerName = text(body.providerName || body.provider || body.name || template.providerName).trim()
  const current = configProviders(config).find(item => text(item.name) === providerName) || {}
  const provider: UnknownRecord = {
    name: providerName || text(current.name) || template.providerName || "custom",
    type: text(body.adapter || body.type || current.type || template.adapter).trim(),
    baseURL: body.baseURL === undefined ? text(current.baseURL ?? template.baseURL).trim() : text(body.baseURL).trim(),
    apiKey: body.apiKey === undefined ? text(current.apiKey).trim() : text(body.apiKey).trim(),
    authType: text(body.authType || current.authType || template.authType),
    authHeader: body.authHeader === undefined
      ? text(current.authHeader ?? template.authHeader).trim()
      : text(body.authHeader).trim(),
    headers: isRecord(body.headers) ? body.headers : record(current.headers),
    query: isRecord(body.query) ? body.query : record(current.query),
    params: isRecord(body.params) ? body.params : record(current.params),
  }
  return {
    template,
    provider,
    channel: {
      id: text(provider.name) || "provider-preview",
      name: text(provider.name) || "provider-preview",
      type: text(provider.type) || "openai-compatible",
      enabled: true,
      model: text(body.modelIdentifier || body.model || template.modelIdentifier).trim(),
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      authType: provider.authType,
      authHeader: provider.authHeader,
      headers: provider.headers,
      query: provider.query,
      params: provider.params,
      provider,
    },
  }
}

/** 对管理台的点路径补丁做原型污染防护，并返回变更路径供审计和提示使用。 */
export function applyConfigPatch(base: UnknownRecord, patch: UnknownRecord = {}): { next: UnknownRecord; changedPaths: string[] } {
  if (!isRecord(patch)) throw new Error("patch must be an object")
  const next = cloneRecord(base)
  const changedPaths: string[] = []
  for (const [pathKey, value] of Object.entries(patch)) {
    const pathParts = pathKey.split(".").map(item => item.trim()).filter(Boolean)
    if (!pathParts.length) throw new Error("patch path cannot be empty")
    if (pathParts.some(part => unsafeConfigPathKeys.has(part))) throw new Error(`unsafe patch path: ${pathKey}`)
    let cursor: UnknownRecord = next
    for (const part of pathParts.slice(0, -1)) {
      if (!isRecord(cursor[part])) cursor[part] = {}
      cursor = cursor[part] as UnknownRecord
    }
    cursor[pathParts[pathParts.length - 1]] = value
    changedPaths.push(pathParts.join("."))
  }
  return { next, changedPaths }
}

export function setDefaultModelConfig(config: UnknownRecord, modelName = "", taskName = "replyer"): UnknownRecord {
  const name = text(modelName).trim()
  const taskId = sanitizeIdentifier(taskName || "replyer", 80, "custom")
  const models = configModels(config)
  if (!models.some(item => text(item.name) === name)) throw new Error(`model not found: ${name}`)
  const tasks = configTasks(config)
  const current = tasks[taskId] || {}
  const existingList = Array.isArray(current.modelList) ? current.modelList.map(text) : []
  const task = {
    ...current,
    modelList: [name, ...existingList.filter(item => item !== name)],
    selectionStrategy: text(current.selectionStrategy) || "sequential",
  }
  return {
    ...config,
    chat: { ...record(config.chat), defaultTask: taskId, defaultChannel: name },
    modelTasks: { ...tasks, [taskId]: task },
  }
}

export function deleteModelConfig(config: UnknownRecord, modelName = ""): { next: UnknownRecord; deleted: string; fallbackModel: string } {
  const name = text(modelName).trim()
  if (!name) throw new Error("model name is required")
  const models = configModels(config)
  if (!models.some(item => text(item.name) === name)) throw new Error(`model not found: ${name}`)
  if (models.length <= 1) throw new Error("cannot delete the last model")
  const nextModels = models.filter(item => text(item.name) !== name)
  const fallbackModel = text(nextModels[0]?.name)
  const nextTasks: Record<string, UnknownRecord> = {}
  for (const [taskName, task] of Object.entries(configTasks(config))) {
    const modelList = Array.isArray(task.modelList) ? task.modelList.map(text).filter(item => item !== name) : []
    nextTasks[taskName] = { ...task, modelList: modelList.length ? modelList : (fallbackModel ? [fallbackModel] : []) }
  }
  const chat = { ...record(config.chat) }
  if (text(chat.defaultChannel) === name) chat.defaultChannel = fallbackModel
  return { next: { ...config, chat, models: nextModels, modelTasks: nextTasks }, deleted: name, fallbackModel }
}

export function updateModelConfig(config: UnknownRecord, modelName = "", patch: UnknownRecord = {}): UnknownRecord {
  const name = text(modelName).trim()
  if (!name) throw new Error("model name is required")
  if (!isRecord(patch)) throw new Error("model patch must be an object")
  const models = configModels(config)
  const index = models.findIndex(item => text(item.name) === name)
  if (index < 0) throw new Error(`model not found: ${name}`)
  const current = models[index]
  const providerName = patch.apiProvider === undefined ? text(current.apiProvider) : text(patch.apiProvider).trim()
  if (providerName && !configProviders(config).some(item => text(item.name) === providerName)) throw new Error(`provider not found: ${providerName}`)
  const currentCapabilities = record(current.capabilities)
  const patchCapabilities = record(patch.capabilities)
  const nextModel: UnknownRecord = {
    ...current,
    modelIdentifier: patch.modelIdentifier === undefined ? current.modelIdentifier : text(patch.modelIdentifier).trim(),
    apiProvider: providerName,
    adapter: text(patch.adapter || current.adapter) || "openai-compatible",
    visual: patch.visual === undefined ? Boolean(current.visual) : Boolean(patch.visual),
    toolUse: patch.toolUse === undefined ? current.toolUse !== false : patch.toolUse !== false,
    priceIn: patch.priceIn === undefined ? Number(current.priceIn || 0) : Number(patch.priceIn || 0),
    priceOut: patch.priceOut === undefined ? Number(current.priceOut || 0) : Number(patch.priceOut || 0),
    params: isRecord(patch.params) ? patch.params : record(current.params),
    timeoutMs: patch.timeoutMs === undefined ? current.timeoutMs : (patch.timeoutMs === null || patch.timeoutMs === "" ? undefined : Number(patch.timeoutMs)),
    contextWindowTokens: patch.contextWindowTokens === undefined ? current.contextWindowTokens : (patch.contextWindowTokens === null || patch.contextWindowTokens === "" ? undefined : Number(patch.contextWindowTokens)),
    stream: patch.stream === undefined ? current.stream : (patch.stream === null || patch.stream === "" ? undefined : Boolean(patch.stream)),
    reasoning: patch.reasoning === undefined ? (current.reasoning || null) : normalizeReasoningPatch(patch.reasoning),
    capabilities: patch.capabilities === undefined
      ? { chat: currentCapabilities.chat !== false, embedding: Boolean(currentCapabilities.embedding) }
      : { chat: patchCapabilities.chat !== false, embedding: Boolean(patchCapabilities.embedding) },
    embedding: patch.embedding === undefined
      ? (current.embedding ? clone(current.embedding) : undefined)
      : (isRecord(patch.embedding) ? clone(patch.embedding) : undefined),
    toolPolicy: patch.toolPolicy === undefined
      ? (current.toolPolicy ? clone(current.toolPolicy) : undefined)
      : (isRecord(patch.toolPolicy) ? clone(patch.toolPolicy) : undefined),
    responses: patch.responses === undefined
      ? (current.responses ? clone(current.responses) : undefined)
      : (isRecord(patch.responses) ? clone(patch.responses) : undefined),
  }
  if (nextModel.timeoutMs === undefined) delete nextModel.timeoutMs
  if (nextModel.stream === undefined) delete nextModel.stream
  if (!nextModel.reasoning) delete nextModel.reasoning
  if (!nextModel.embedding) delete nextModel.embedding
  if (!nextModel.responses) delete nextModel.responses
  if (!nextModel.toolPolicy) delete nextModel.toolPolicy
  const nextModels = [...models]
  nextModels[index] = nextModel
  return { ...config, models: nextModels }
}

export function updateProviderConfig(config: UnknownRecord, providerName = "", patch: UnknownRecord = {}): UnknownRecord {
  const name = text(providerName).trim()
  if (!name) throw new Error("provider name is required")
  if (!isRecord(patch)) throw new Error("provider patch must be an object")
  const providers = configProviders(config)
  const index = providers.findIndex(item => text(item.name) === name)
  if (index < 0) throw new Error(`provider not found: ${name}`)
  const current = providers[index]
  const nextProvider: UnknownRecord = {
    ...current,
    type: text(patch.type || current.type) || "openai-compatible",
    baseURL: patch.baseURL === undefined ? current.baseURL : text(patch.baseURL).trim(),
    authType: text(patch.authType || current.authType) || "bearer",
    authHeader: patch.authHeader === undefined ? current.authHeader : text(patch.authHeader).trim(),
    headers: isRecord(patch.headers) ? patch.headers : record(current.headers),
    query: isRecord(patch.query) ? patch.query : record(current.query),
  }
  if (patch.clearApiKey === true) nextProvider.apiKey = ""
  else if (patch.apiKey !== undefined && text(patch.apiKey).trim()) nextProvider.apiKey = text(patch.apiKey).trim()
  const nextProviders = [...providers]
  nextProviders[index] = nextProvider
  return { ...config, apiProviders: nextProviders }
}

export function deleteProviderConfig(config: UnknownRecord, providerName = ""): { next: UnknownRecord; deleted: string; removedModels: string[]; fallbackModel: string } {
  const name = text(providerName).trim()
  if (!name) throw new Error("provider name is required")
  const providers = configProviders(config)
  if (!providers.some(item => text(item.name) === name)) throw new Error(`provider not found: ${name}`)
  const models = configModels(config)
  const removedModels = models.filter(item => text(item.apiProvider) === name).map(item => text(item.name))
  const removedSet = new Set(removedModels)
  const nextModels = models.filter(item => text(item.apiProvider) !== name)
  const fallbackModel = text(nextModels[0]?.name)
  const nextTasks: Record<string, UnknownRecord> = {}
  for (const [taskName, task] of Object.entries(configTasks(config))) {
    const modelList = Array.isArray(task.modelList) ? task.modelList.map(text).filter(item => !removedSet.has(item)) : []
    nextTasks[taskName] = { ...task, modelList: modelList.length ? modelList : (fallbackModel ? [fallbackModel] : []) }
  }
  const nextChannels = records(config.channels).filter(channel => {
    const channelProvider = text(channel.apiProvider || channel.provider).trim()
    return channelProvider !== name
  })
  const nextChat = { ...record(config.chat) }
  if (removedSet.has(text(nextChat.defaultChannel))) nextChat.defaultChannel = fallbackModel
  if (nextChat.defaultChannel && !nextModels.some(item => text(item.name) === text(nextChat.defaultChannel)) && !nextChannels.some(item => text(item.id) === text(nextChat.defaultChannel))) nextChat.defaultChannel = fallbackModel
  const nextMediaRecognition = { ...record(config.mediaRecognition) }
  if (removedSet.has(text(nextMediaRecognition.recognitionModel).trim())) nextMediaRecognition.recognitionModel = ""
  return {
    next: {
      ...config,
      chat: nextChat,
      mediaRecognition: nextMediaRecognition,
      channels: nextChannels,
      apiProviders: providers.filter(item => text(item.name) !== name),
      models: nextModels,
      modelTasks: nextTasks,
    },
    deleted: name,
    removedModels,
    fallbackModel,
  }
}

export function addModelsToProvider(config: UnknownRecord, providerName = "", modelIdentifiers: unknown[] = []): UnknownRecord {
  const name = text(providerName).trim()
  if (!name) throw new Error("provider name is required")
  const provider = configProviders(config).find(item => text(item.name) === name)
  if (!provider) throw new Error(`provider not found: ${name}`)
  const identifiers = [...new Set((Array.isArray(modelIdentifiers) ? modelIdentifiers : []).map(text).map(item => item.trim()).filter(Boolean))]
  if (!identifiers.length) throw new Error("modelIdentifiers is required")
  const template = listProviderTemplates().find(item => item.adapter === (text(provider.type) || "openai-compatible"))
  const currentModels = configModels(config)
  const fallbackModel = currentModels.find(item => text(item.apiProvider) === name)
  const taskName = "replyer"
  const nextModels = [...currentModels]
  const addedNames: string[] = []
  for (const modelIdentifier of identifiers) {
    const existingIndex = nextModels.findIndex(item => text(item.apiProvider) === name && text(item.modelIdentifier) === modelIdentifier)
    const existing = existingIndex >= 0 ? nextModels[existingIndex] : {}
    const generatedName = sanitizeIdentifier(`${name}-${modelIdentifier}`, 80, "custom")
    const fallbackCapabilities = record(fallbackModel?.capabilities)
    const existingCapabilities = record(existing.capabilities)
    const nextModel: UnknownRecord = {
      ...existing,
      name: existingIndex >= 0 ? existing.name : generatedName,
      modelIdentifier,
      apiProvider: name,
      adapter: text(provider.type) || text(fallbackModel?.adapter) || template?.adapter || "openai-compatible",
      visual: existingIndex >= 0 ? Boolean(existing.visual) : (fallbackModel?.visual ?? template?.visual ?? false),
      toolUse: existingIndex >= 0 ? existing.toolUse !== false : (fallbackModel?.toolUse ?? template?.toolUse ?? true),
      contextWindowTokens: existingIndex >= 0 ? existing.contextWindowTokens : (fallbackModel?.contextWindowTokens ?? 200000),
      capabilities: existingIndex >= 0
        ? { chat: existingCapabilities.chat !== false, embedding: Boolean(existingCapabilities.embedding) }
        : { chat: fallbackCapabilities.chat !== false, embedding: Boolean(fallbackCapabilities.embedding) },
      embedding: existingIndex >= 0 ? (existing.embedding ? clone(existing.embedding) : undefined) : (fallbackModel?.embedding ? clone(fallbackModel.embedding) : undefined),
      priceIn: existingIndex >= 0 ? Number(existing.priceIn || 0) : Number(fallbackModel?.priceIn || 0),
      priceOut: existingIndex >= 0 ? Number(existing.priceOut || 0) : Number(fallbackModel?.priceOut || 0),
      params: existingIndex >= 0 ? record(existing.params) : record(fallbackModel?.params || template?.params),
      reasoning: existingIndex >= 0 ? normalizeReasoningPatch(existing.reasoning) : normalizeReasoningPatch(fallbackModel?.reasoning),
    }
    if (!nextModel.reasoning) delete nextModel.reasoning
    if (existingIndex >= 0) nextModels[existingIndex] = nextModel
    else nextModels.push(nextModel)
    addedNames.push(text(nextModel.name))
  }
  const tasks = configTasks(config)
  const currentTask = tasks[taskName] || {}
  const currentList = Array.isArray(currentTask.modelList) ? currentTask.modelList.map(text) : []
  return {
    ...config,
    models: nextModels,
    modelTasks: {
      ...tasks,
      [taskName]: {
        ...currentTask,
        modelList: [...new Set([...currentList, ...addedNames])],
        selectionStrategy: text(currentTask.selectionStrategy) || "sequential",
      },
    },
  }
}

export type { ProviderTemplate }
