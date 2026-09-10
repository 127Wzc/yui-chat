import { sanitizeIdentifier, shortHash } from "../../core/shared/identifiers.js"
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
  return isRecord(value) ? record(clone(value)) : {}
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

function modelPurpose(value: UnknownRecord = {}): "chat" | "image" | "embedding" {
  const declared = text(value.purpose).trim().toLowerCase()
  if (declared === "image" || declared === "embedding" || declared === "chat") return declared
  const adapter = text(value.adapter).trim().toLowerCase()
  if (["openai-images", "openai-chat-completions", "gemini-images"].includes(adapter)) return "image"
  return record(value.capabilities).embedding === true && record(value.capabilities).chat === false ? "embedding" : "chat"
}

function taskPurpose(taskName: string, task: UnknownRecord = {}): "chat" | "image" | "embedding" {
  const declared = text(task.purpose).trim().toLowerCase()
  if (declared === "image" || declared === "embedding" || declared === "chat") return declared
  if (taskName === "imageGeneration") return "image"
  if (taskName === "embedding") return "embedding"
  return "chat"
}

function imageAdapter(value: unknown, fallback = "openai-images"): string {
  const adapter = text(value).trim()
  if (adapter === "gemini" || adapter === "gemini-images") return "gemini-images"
  if (["openai-images", "openai-chat-completions"].includes(adapter)) return "openai-images"
  return fallback === "gemini-images" || fallback === "gemini" ? "gemini-images" : "openai-images"
}

function imageProtocol(value: unknown, fallback = "openai-images"): string {
  const protocol = text(value).trim()
  return ["openai-images", "openai-chat-completions", "gemini-images"].includes(protocol)
    ? protocol
    : fallback
}

function generatedModelName(providerName: string, modelIdentifier: string, used: Set<string>): string {
  const suffix = `-${shortHash(`${providerName}:${modelIdentifier}`)}`
  const stem = sanitizeIdentifier(`${providerName}-${modelIdentifier}`, Math.max(1, 80 - suffix.length), "custom")
  const base = `${stem}${suffix}`.slice(0, 80)
  if (!used.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base.slice(0, Math.max(1, 80 - String(index).length - 1))}-${index}`
    if (!used.has(candidate)) return candidate
  }
}

/** 管理台表单的供应商草稿只负责组合配置，不触发网络请求或保存操作。 */
export function resolveProviderDraft(body: UnknownRecord = {}, config: UnknownRecord = {}): UnknownRecord {
  const template = getProviderTemplate(body.templateId || body.template)
  const providerName = text(body.providerName || body.provider || body.name || template.providerName).trim()
  const current = configProviders(config).find(item => text(item.name) === providerName) || {}
  const requestedPurpose = text(body.purpose || body.modelPurpose).trim().toLowerCase()
  const providerType = text(body.providerType || body.providerAdapter || body.type || current.type || template.adapter).trim() || template.adapter
  const requestedImageAdapter = requestedPurpose === "image"
    ? imageAdapter(body.adapter || body.imageAdapter, providerType)
    : ""
  const provider: UnknownRecord = {
    name: providerName || text(current.name) || template.providerName || "custom",
    // Provider type describes the endpoint family. Image models can override it
    // without turning the whole provider into an image-only provider.
    type: providerType,
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
      type: requestedImageAdapter || text(provider.type) || "openai-compatible",
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
  const model = models.find(item => text(item.name) === name)
  if (!model) throw new Error(`model not found: ${name}`)
  const tasks = configTasks(config)
  const current = tasks[taskId] || {}
  const purpose = modelPurpose(model)
  const expectedPurpose = taskId === "imageGeneration" || text(current.purpose) === "image" ? "image" : taskId === "embedding" || text(current.purpose) === "embedding" ? "embedding" : "chat"
  if (purpose !== expectedPurpose) throw new Error(`模型用途不匹配：任务 ${taskId} 需要 ${expectedPurpose} 模型`)
  const existingList = Array.isArray(current.modelList) ? current.modelList.map(text) : []
  const task = {
    ...current,
    modelList: [name, ...existingList.filter(item => item !== name)],
    selectionStrategy: text(current.selectionStrategy) || (expectedPurpose === "image" ? "fallback" : "sequential"),
  }
  return {
    ...config,
    ...(expectedPurpose === "chat" ? { chat: { ...record(config.chat), defaultTask: taskId, defaultChannel: name } } : {}),
    modelTasks: { ...tasks, [taskId]: { ...task, ...(expectedPurpose === "image" ? { purpose: "image" } : {}) } },
  }
}

export function deleteModelConfig(config: UnknownRecord, modelName = ""): { next: UnknownRecord; deleted: string; fallbackModel: string } {
  const name = text(modelName).trim()
  if (!name) throw new Error("model name is required")
  const models = configModels(config)
  if (!models.some(item => text(item.name) === name)) throw new Error(`model not found: ${name}`)
  if (models.length <= 1) throw new Error("cannot delete the last model")
  const nextModels = models.filter(item => text(item.name) !== name)
  const fallbackModel = text(nextModels.find(item => modelPurpose(item) === "chat")?.name)
  const nextTasks: Record<string, UnknownRecord> = {}
  for (const [taskName, task] of Object.entries(configTasks(config))) {
    const modelList = Array.isArray(task.modelList) ? task.modelList.map(text).filter(item => item !== name) : []
    const fallback = text(nextModels.find(item => modelPurpose(item) === taskPurpose(taskName, task))?.name)
    nextTasks[taskName] = { ...task, modelList: modelList.length ? modelList : (fallback ? [fallback] : []) }
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
  const currentProviderName = text(current.apiProvider).trim()
  const providerName = patch.apiProvider === undefined ? currentProviderName : text(patch.apiProvider).trim()
  if (patch.apiProvider !== undefined && providerName !== currentProviderName) {
    throw new Error(`模型所属渠道不可修改：${name}；请先在目标渠道导入模型`)
  }
  if (providerName && !configProviders(config).some(item => text(item.name) === providerName)) throw new Error(`provider not found: ${providerName}`)
  const inferredPurpose = modelPurpose(current)
  const purpose = patch.purpose === undefined ? inferredPurpose : modelPurpose({ ...current, ...patch, purpose: patch.purpose })
  const currentAdapter = text(patch.adapter || current.adapter) || "openai-compatible"
  const requestedImageProtocol = purpose === "image"
    ? imageProtocol(record(patch.image).protocol || patch.adapter || record(current.image).protocol || currentAdapter, text(record(current.image).protocol) || (text(currentAdapter) === "gemini" ? "gemini-images" : "openai-images"))
    : ""
  const adapter = purpose === "image"
    ? imageAdapter(requestedImageProtocol || currentAdapter, text(currentAdapter) === "gemini" ? "gemini-images" : "openai-images")
    : purpose === "chat" && ["openai-images", "gemini-images"].includes(currentAdapter)
      ? (currentAdapter === "gemini-images" ? "gemini" : "openai-compatible")
      : currentAdapter
  const capabilitiesValue = purpose === "image"
    ? { chat: false, embedding: false }
    : purpose === "embedding"
      ? { chat: false, embedding: true }
      : { chat: true, embedding: false }
  const nextModel: UnknownRecord = {
    ...current,
    modelIdentifier: patch.modelIdentifier === undefined ? current.modelIdentifier : text(patch.modelIdentifier).trim(),
    apiProvider: providerName,
    adapter,
    purpose,
    visual: purpose === "chat" && (patch.visual === undefined ? Boolean(current.visual) : Boolean(patch.visual)),
    toolUse: purpose === "chat" && (patch.toolUse === undefined ? current.toolUse !== false : patch.toolUse !== false),
    priceIn: patch.priceIn === undefined ? Number(current.priceIn || 0) : Number(patch.priceIn || 0),
    priceOut: patch.priceOut === undefined ? Number(current.priceOut || 0) : Number(patch.priceOut || 0),
    params: isRecord(patch.params) ? patch.params : record(current.params),
    timeoutMs: patch.timeoutMs === undefined ? current.timeoutMs : (patch.timeoutMs === null || patch.timeoutMs === "" ? undefined : Number(patch.timeoutMs)),
    contextWindowTokens: purpose === "chat"
      ? (patch.contextWindowTokens === undefined ? current.contextWindowTokens : (patch.contextWindowTokens === null || patch.contextWindowTokens === "" ? undefined : Number(patch.contextWindowTokens)))
      : undefined,
    stream: purpose === "chat" || purpose === "image"
      ? (patch.stream === undefined ? current.stream : (patch.stream === null || patch.stream === "" ? undefined : Boolean(patch.stream)))
      : undefined,
    reasoning: purpose === "chat" ? (patch.reasoning === undefined ? (current.reasoning || null) : normalizeReasoningPatch(patch.reasoning)) : undefined,
    capabilities: capabilitiesValue,
    embedding: purpose === "embedding"
      ? (patch.embedding === undefined ? (current.embedding ? clone(current.embedding) : undefined) : (isRecord(patch.embedding) ? clone(patch.embedding) : undefined))
      : undefined,
    image: purpose === "image"
      ? {
        ...(patch.image === undefined ? cloneRecord(current.image) : (isRecord(patch.image) ? clone(patch.image) : {})),
        protocol: requestedImageProtocol || "openai-images",
      }
      : undefined,
    toolPolicy: purpose === "chat" ? (patch.toolPolicy === undefined
      ? (current.toolPolicy ? clone(current.toolPolicy) : undefined)
      : (isRecord(patch.toolPolicy) ? clone(patch.toolPolicy) : undefined)) : undefined,
    responses: purpose === "chat" ? (patch.responses === undefined
      ? (current.responses ? clone(current.responses) : undefined)
      : (isRecord(patch.responses) ? clone(patch.responses) : undefined)) : undefined,
  }
  if (nextModel.timeoutMs === undefined) delete nextModel.timeoutMs
  if (nextModel.contextWindowTokens === undefined) delete nextModel.contextWindowTokens
  if (nextModel.stream === undefined) delete nextModel.stream
  if (!nextModel.reasoning) delete nextModel.reasoning
  if (!nextModel.embedding) delete nextModel.embedding
  if (!nextModel.image) delete nextModel.image
  if (!nextModel.responses) delete nextModel.responses
  if (!nextModel.toolPolicy) delete nextModel.toolPolicy
  const nextModels = [...models]
  nextModels[index] = nextModel
  const nextConfig: UnknownRecord = { ...config, models: nextModels }
  // Changing a model's single purpose must also move its task membership. This
  // keeps an edited chat model from becoming unreachable after it is switched
  // to image generation (and vice versa).
  if (purpose !== inferredPurpose) {
    const tasks = configTasks(config)
    const targetTaskName = purpose === "image"
      ? "imageGeneration"
      : purpose === "chat"
        ? text(record(config.chat).defaultTask || "replyer") || "replyer"
        : ""
    const nextTasks: Record<string, UnknownRecord> = {}
    for (const [taskName, task] of Object.entries(tasks)) {
      const currentList = Array.isArray(task.modelList) ? task.modelList.map(text) : []
      const taskMatches = taskPurpose(taskName, task) === purpose
      const shouldReceive = targetTaskName === taskName && taskMatches
      const nextList = currentList.filter(item => item !== name)
      if (shouldReceive) nextList.unshift(name)
      nextTasks[taskName] = {
        ...task,
        ...(taskName === "imageGeneration" && purpose === "image" ? { purpose: "image" } : {}),
        modelList: [...new Set(nextList)],
      }
    }
    if (targetTaskName && !nextTasks[targetTaskName]) {
      nextTasks[targetTaskName] = {
        ...(purpose === "image" ? { purpose: "image", selectionStrategy: "fallback" } : { selectionStrategy: "sequential" }),
        modelList: [name],
      }
    } else if (targetTaskName) {
      const target = nextTasks[targetTaskName]
      if (taskPurpose(targetTaskName, target) === purpose) {
        const targetList = Array.isArray(target.modelList) ? target.modelList.map(text) : []
        if (!targetList.includes(name)) target.modelList = [name, ...targetList]
        if (purpose === "image") target.purpose = "image"
      }
    }
    nextConfig.modelTasks = nextTasks
  }
  return nextConfig
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
  const fallbackModel = text(nextModels.find(item => modelPurpose(item) === "chat")?.name)
  const nextTasks: Record<string, UnknownRecord> = {}
  for (const [taskName, task] of Object.entries(configTasks(config))) {
    const modelList = Array.isArray(task.modelList) ? task.modelList.map(text).filter(item => !removedSet.has(item)) : []
    const fallback = text(nextModels.find(item => modelPurpose(item) === taskPurpose(taskName, task))?.name)
    nextTasks[taskName] = { ...task, modelList: modelList.length ? modelList : (fallback ? [fallback] : []) }
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

export interface AddModelsOptions {
  purpose?: string
  adapter?: string
  image?: UnknownRecord
  taskName?: string
  stream?: boolean
}

export function addModelsToProvider(config: UnknownRecord, providerName = "", modelIdentifiers: unknown[] = [], options: AddModelsOptions = {}): UnknownRecord {
  const name = text(providerName).trim()
  if (!name) throw new Error("provider name is required")
  const provider = configProviders(config).find(item => text(item.name) === name)
  if (!provider) throw new Error(`provider not found: ${name}`)
  const identifiers = [...new Set((Array.isArray(modelIdentifiers) ? modelIdentifiers : []).map(text).map(item => item.trim()).filter(Boolean))]
  if (!identifiers.length) throw new Error("modelIdentifiers is required")
  const template = listProviderTemplates().find(item => item.adapter === (text(provider.type) || "openai-compatible"))
    || getProviderTemplate(provider.type)
  const requestedPurpose = ["chat", "image", "embedding"].includes(text(options.purpose).trim().toLowerCase()) ? text(options.purpose).trim().toLowerCase() : "chat"
  const currentModels = configModels(config)
  const nextModels = [...currentModels]
  const usedNames = new Set(nextModels.map(item => text(item.name)).filter(Boolean))
  const fallbackForPurpose = (purpose: "chat" | "image" | "embedding"): UnknownRecord | undefined => currentModels.find(item => text(item.apiProvider) === name && modelPurpose(item) === purpose)
  const addedNames: string[] = []
  const addedByPurpose: Record<"chat" | "image" | "embedding", string[]> = { chat: [], image: [], embedding: [] }
  for (const modelIdentifier of identifiers) {
    const existingIndex = nextModels.findIndex(item => text(item.apiProvider) === name && text(item.modelIdentifier) === modelIdentifier)
    const existing = existingIndex >= 0 ? nextModels[existingIndex] : {}
    const generatedName = generatedModelName(name, modelIdentifier, usedNames)
    const existingPurpose = modelPurpose(existing)
    const purpose = (options.purpose ? requestedPurpose : (existingIndex >= 0 ? existingPurpose : "chat")) as "chat" | "image" | "embedding"
    const fallbackModel = fallbackForPurpose(purpose)
    const fallbackChat = fallbackForPurpose("chat")
    const fallbackEmbedding = fallbackForPurpose("embedding")
    const requestedImageProtocol = imageProtocol(record(options.image).protocol || options.adapter || (text(provider.type) === "gemini" ? "gemini-images" : "openai-images"), text(record(existing.image).protocol) || (text(provider.type) === "gemini" ? "gemini-images" : "openai-images"))
    const imageConfig = purpose === "image"
      ? { ...cloneRecord(options.image), protocol: requestedImageProtocol }
      : undefined
    const nextModel: UnknownRecord = {
      ...existing,
      name: existingIndex >= 0 ? existing.name : generatedName,
      modelIdentifier,
      apiProvider: name,
      adapter: purpose === "image" ? imageAdapter(requestedImageProtocol, text(provider.type) === "gemini" ? "gemini-images" : "openai-images") : (text(options.adapter) || text(provider.type) || text(fallbackChat?.adapter) || template?.adapter || "openai-compatible"),
      purpose,
      visual: purpose === "chat" && (existingIndex >= 0 ? Boolean(existing.visual) : (fallbackChat?.visual ?? template?.visual ?? false)),
      toolUse: purpose === "chat" && (existingIndex >= 0 ? existing.toolUse !== false : (fallbackChat?.toolUse ?? template?.toolUse ?? true)),
      ...(purpose === "chat"
        ? (existingIndex >= 0
          ? (existing.contextWindowTokens === undefined ? {} : { contextWindowTokens: existing.contextWindowTokens })
          : { contextWindowTokens: fallbackChat?.contextWindowTokens ?? 200000 })
        : {}),
      capabilities: purpose === "image"
        ? { chat: false, embedding: false }
        : purpose === "embedding"
          ? { chat: false, embedding: true }
          : { chat: true, embedding: false },
      embedding: purpose === "embedding" ? (existingIndex >= 0 ? (existing.embedding ? clone(existing.embedding) : undefined) : (fallbackEmbedding?.embedding ? clone(fallbackEmbedding.embedding) : undefined)) : undefined,
      ...(purpose === "image" ? { image: imageConfig || {} } : {}),
      responses: purpose === "chat"
        ? (existingIndex >= 0 ? (existing.responses ? clone(existing.responses) : undefined) : (template?.responses ? clone(template.responses) : undefined))
        : undefined,
      priceIn: existingIndex >= 0 ? Number(existing.priceIn || 0) : Number(fallbackModel?.priceIn || 0),
      priceOut: existingIndex >= 0 ? Number(existing.priceOut || 0) : Number(fallbackModel?.priceOut || 0),
      params: existingIndex >= 0 ? record(existing.params) : record(fallbackModel?.params || (purpose === "chat" ? template?.params : {})),
      reasoning: purpose === "chat"
        ? (existingIndex >= 0 ? normalizeReasoningPatch(existing.reasoning) : normalizeReasoningPatch(fallbackChat?.reasoning))
        : undefined,
      stream: (purpose === "chat" || purpose === "image")
        ? (options.stream === undefined ? (existingIndex >= 0 ? existing.stream : undefined) : options.stream === true)
        : undefined,
    }
    if (!nextModel.reasoning) delete nextModel.reasoning
    if (nextModel.stream === undefined) delete nextModel.stream
    if (!nextModel.responses) delete nextModel.responses
    if (existingIndex >= 0) nextModels[existingIndex] = nextModel
    else nextModels.push(nextModel)
    usedNames.add(text(nextModel.name))
    addedNames.push(text(nextModel.name))
    addedByPurpose[purpose].push(text(nextModel.name))
  }
  const tasks = configTasks(config)
  const explicitTaskName = text(options.taskName).trim()
  const taskName = explicitTaskName || (options.purpose ? (requestedPurpose === "image" ? "imageGeneration" : requestedPurpose === "embedding" ? "" : "replyer") : "")
  if (!taskName) {
    const nextTasks: Record<string, UnknownRecord> = { ...tasks }
    for (const [purpose, names] of Object.entries(addedByPurpose) as Array<["chat" | "image" | "embedding", string[]]>) {
      if (!names.length || purpose === "embedding") continue
      const targetTaskName = purpose === "image" ? "imageGeneration" : "replyer"
      const currentTask = nextTasks[targetTaskName] || {}
      const currentList = Array.isArray(currentTask.modelList) ? currentTask.modelList.map(text) : []
      nextTasks[targetTaskName] = {
        ...currentTask,
        ...(purpose === "image" ? { purpose: "image" } : {}),
        modelList: [...new Set([...currentList, ...names])],
        selectionStrategy: text(currentTask.selectionStrategy) || (purpose === "image" ? "fallback" : "sequential"),
      }
    }
    return { ...config, models: nextModels, modelTasks: nextTasks }
  }
  const currentTask = tasks[taskName] || {}
  const currentList = Array.isArray(currentTask.modelList) ? currentTask.modelList.map(text) : []
  return {
    ...config,
    models: nextModels,
    modelTasks: {
      ...tasks,
      [taskName]: {
        ...currentTask,
        ...(requestedPurpose === "image" ? { purpose: "image" } : {}),
        modelList: [...new Set([...currentList, ...addedNames])],
        selectionStrategy: text(currentTask.selectionStrategy) || (requestedPurpose === "image" ? "fallback" : "sequential"),
      },
    },
  }
}

export type { ProviderTemplate }
