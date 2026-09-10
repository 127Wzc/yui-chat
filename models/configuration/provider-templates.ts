import type { JsonValue } from "../../core/message-chain/types.js"
import { cloneJsonValue } from "../../core/shared/json-values.js"

type UnknownRecord = Record<string, unknown>

/** 管理台新增渠道时使用的稳定模板；模板不是运行时渠道本身。 */
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
  responses?: Record<string, JsonValue>
}

export interface ProviderConfigBundle {
  template: ProviderTemplate
  provider: UnknownRecord
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

export const providerTemplates: Record<string, ProviderTemplate> = {
  openai: {
    id: "openai", label: "OpenAI", adapter: "openai-compatible", providerName: "openai-main",
    baseURL: "https://api.openai.com/v1", authType: "bearer", authHeader: "Authorization",
    modelIdentifier: "gpt-4o-mini", visual: true, toolUse: true, taskName: "replyer", params: { temperature: 0.7 },
  },
  openai_responses: {
    id: "openai_responses", label: "OpenAI Responses", adapter: "openai-responses", providerName: "openai-responses",
    baseURL: "https://api.openai.com/v1", authType: "bearer", authHeader: "Authorization",
    modelIdentifier: "gpt-5.4", visual: true, toolUse: true, taskName: "replyer", params: {},
    responses: {
      stateMode: "auto",
      store: false,
      parallelToolCalls: true,
      webSearch: { params: {} },
      fileSearch: { enabled: false, vectorStoreIds: [], maxNumResults: 8 },
    },
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

// 管理台只展示最常用的三类连接。其余名称作为读取旧配置/脚本的别名保留，
// 不再占用新增渠道表单的选择项。
const publicProviderTemplateIds = ["openai", "gemini", "openai_compatible"] as const

export function getProviderTemplate(id: unknown = ""): ProviderTemplate {
  const key = text(id).trim()
  const aliases: Record<string, string> = {
    "openai-responses": "openai_responses",
    "openai-compatible": "openai_compatible",
    "local-openai": "local_openai",
    "chat-glm": "chatglm",
  }
  return providerTemplates[key] || providerTemplates[aliases[key]] || providerTemplates.openai_compatible
}

export function listProviderTemplates(): ProviderTemplate[] {
  return publicProviderTemplateIds
    .map(id => providerTemplates[id])
    .filter((item): item is ProviderTemplate => Boolean(item))
    .map(item => ({ ...item, params: { ...item.params }, ...(item.responses ? { responses: cloneJsonValue(item.responses) as Record<string, JsonValue> } : {}) }))
}

export function sanitizeProviderId(value: unknown = ""): string {
  return text(value || "custom").trim().replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "custom"
}

/** 仅创建供应商连接；模型必须在供应商创建后从模型列表中导入。 */
export function buildProviderConfig(input: UnknownRecord = {}): ProviderConfigBundle {
  const template = getProviderTemplate(input.templateId || input.template)
  const providerName = sanitizeProviderId(input.providerName || input.providerId || input.name || template.providerName)
  const providerType = sanitizeProviderId(input.providerType || input.providerAdapter || input.type || template.adapter)
  const provider: UnknownRecord = {
    name: providerName,
    type: providerType,
    baseURL: text(input.baseURL ?? template.baseURL).trim(),
    apiKey: text(input.apiKey).trim(),
    authType: text(input.authType || template.authType),
    authHeader: text(input.authHeader || template.authHeader).trim(),
    headers: record(input.headers),
    query: record(input.query),
  }
  return { template, provider }
}

/** 新增供应商不覆盖同名连接，避免误把另一个渠道的模型换到新端点。 */
export function applyProviderConfig(config: UnknownRecord, bundle: ProviderConfigBundle): UnknownRecord {
  const provider = bundle.provider
  const providers = records(config.apiProviders)
  const name = text(provider.name).trim()
  if (!name) throw new Error("provider name is required")
  if (providers.some(item => text(item.name).trim() === name)) throw new Error(`provider already exists: ${name}`)
  return { ...config, apiProviders: [...providers, provider] }
}
