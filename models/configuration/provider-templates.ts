import type { JsonValue } from "../../core/message-chain/types.js"

type UnknownRecord = Record<string, unknown>

/** 管理台快速创建供应商时使用的稳定模板；模板不是运行时渠道本身。 */
export interface ProviderTemplate {
  id: string
  label: string
  adapter: string
  providerName: string
  baseURL: string
  authType: string
  authHeader: string
  modelIdentifier: string
  visual: boolean
  toolUse: boolean
  taskName: string
  params: Record<string, JsonValue>
}

export interface ProviderBundle {
  template: ProviderTemplate
  provider: UnknownRecord
  model: UnknownRecord
  models: UnknownRecord[]
  taskName: string
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : Boolean(value)
}

export const providerTemplates: Record<string, ProviderTemplate> = {
  openai: {
    id: "openai", label: "OpenAI", adapter: "openai-compatible", providerName: "openai-main",
    baseURL: "https://api.openai.com/v1", authType: "bearer", authHeader: "Authorization",
    modelIdentifier: "gpt-4o-mini", visual: true, toolUse: true, taskName: "replyer", params: { temperature: 0.7 },
  },
  openai_compatible: {
    id: "openai_compatible", label: "OpenAI Compatible", adapter: "openai-compatible", providerName: "openai-compatible",
    baseURL: "", authType: "bearer", authHeader: "Authorization", modelIdentifier: "gpt-4o-mini",
    visual: true, toolUse: true, taskName: "replyer", params: { temperature: 0.7 },
  },
  local_openai: {
    id: "local_openai", label: "Local OpenAI Gateway", adapter: "openai-compatible", providerName: "local-openai",
    baseURL: "http://127.0.0.1:11434/v1", authType: "none", authHeader: "Authorization", modelIdentifier: "qwen2.5:7b",
    visual: false, toolUse: true, taskName: "replyer", params: { temperature: 0.7 },
  },
  qwen: {
    id: "qwen", label: "Qwen DashScope", adapter: "qwen", providerName: "qwen-main",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", authType: "bearer", authHeader: "Authorization",
    modelIdentifier: "qwen-plus", visual: true, toolUse: true, taskName: "replyer", params: { temperature: 0.7 },
  },
  gemini: {
    id: "gemini", label: "Gemini", adapter: "gemini", providerName: "gemini-main",
    baseURL: "https://generativelanguage.googleapis.com", authType: "query", authHeader: "Authorization",
    modelIdentifier: "gemini-flash-latest", visual: true, toolUse: true, taskName: "replyer", params: { temperature: 0.3 },
  },
  claude: {
    id: "claude", label: "Claude", adapter: "claude", providerName: "claude-main",
    baseURL: "https://api.anthropic.com/v1", authType: "x-api-key", authHeader: "x-api-key",
    modelIdentifier: "claude-3-5-haiku-latest", visual: true, toolUse: true, taskName: "replyer", params: { max_tokens: 1024 },
  },
  chatglm: {
    id: "chatglm", label: "ChatGLM / BigModel", adapter: "chatglm", providerName: "chatglm-main",
    baseURL: "https://open.bigmodel.cn/api/paas/v4", authType: "bearer", authHeader: "Authorization",
    modelIdentifier: "glm-4-flash", visual: false, toolUse: true, taskName: "replyer", params: { temperature: 0.7 },
  },
}

export function getProviderTemplate(id: unknown = ""): ProviderTemplate {
  return providerTemplates[text(id)] || providerTemplates.openai_compatible
}

export function listProviderTemplates(): ProviderTemplate[] {
  return Object.values(providerTemplates).map(item => ({ ...item, params: { ...item.params } }))
}

export function sanitizeProviderId(value: unknown = ""): string {
  return text(value || "custom").trim().replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "custom"
}

export function buildProviderBundle(input: UnknownRecord = {}): ProviderBundle {
  const template = getProviderTemplate(input.templateId || input.template)
  const providerName = sanitizeProviderId(input.providerName || input.providerId || input.name || template.providerName)
  const adapter = sanitizeProviderId(input.adapter || input.type || template.adapter)
  const rawIdentifiers = Array.isArray(input.modelIdentifiers)
    ? input.modelIdentifiers
    : text(input.modelIdentifiers || input.models || input.modelIdentifier || input.model || template.modelIdentifier).split(/[\n,，]+/)
  const identifiers = rawIdentifiers.map(text).map(item => item.trim()).filter(Boolean)
  if (!identifiers.length) throw new Error("modelIdentifier is required")

  const provider: UnknownRecord = {
    name: providerName,
    type: adapter,
    baseURL: text(input.baseURL ?? template.baseURL).trim(),
    apiKey: text(input.apiKey).trim(),
    authType: text(input.authType || template.authType),
    authHeader: text(input.authHeader || template.authHeader).trim(),
    headers: record(input.headers),
    query: record(input.query),
  }
  const models = identifiers.map((modelIdentifier, index) => ({
    name: sanitizeProviderId(index === 0 && input.modelName ? input.modelName : `${providerName}-${modelIdentifier}`),
    modelIdentifier,
    apiProvider: providerName,
    adapter,
    visual: booleanValue(input.visual, template.visual),
    toolUse: input.toolUse === undefined ? template.toolUse : input.toolUse !== false,
    priceIn: Number(input.priceIn || 0),
    priceOut: Number(input.priceOut || 0),
    params: Object.keys(record(input.params)).length ? record(input.params) : { ...template.params },
  }))
  return { template, provider, model: models[0], models, taskName: "replyer" }
}

export function applyProviderBundle(config: UnknownRecord, bundle: ProviderBundle): UnknownRecord {
  const provider = bundle.provider
  const models = bundle.models.length ? bundle.models : [bundle.model].filter(Boolean)
  const modelNames = models.map(model => text(model.name))
  const firstModel = models[0]
  const apiProviders = records(config.apiProviders).filter(item => text(item.name) !== text(provider.name))
  const currentModels = records(config.models).filter(item => !modelNames.includes(text(item.name)))
  const tasks = record(config.modelTasks)
  const currentTask = record(tasks[bundle.taskName])
  const currentList = Array.isArray(currentTask.modelList) ? currentTask.modelList.map(text) : []
  return {
    ...config,
    apiProviders: [...apiProviders, provider],
    models: [...currentModels, ...models],
    modelTasks: {
      ...tasks,
      [bundle.taskName]: {
        ...currentTask,
        modelList: [...new Set([...currentList, ...modelNames])],
        selectionStrategy: text(currentTask.selectionStrategy) || "sequential",
      },
    },
    chat: {
      ...record(config.chat),
      defaultTask: bundle.taskName,
      defaultChannel: text(firstModel?.name || record(config.chat).defaultChannel),
    },
  }
}
