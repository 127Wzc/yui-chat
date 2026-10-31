import { specializedModelAdapter, specializedAdapterPurpose } from "../models/protocol/specialized-adapters.js"
import { migrateStoredReasoning } from "../models/configuration/reasoning.js"
import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { defaults } from "./defaults.js"
import { assertConfigValid, validateConfig } from "./validator.js"
import { writeFileAtomic } from "../core/storage/atomic-file.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { cloneJsonValue as clone, deepFreezeJsonValue as deepFreeze } from "../core/shared/json-values.js"
import type {
  ConfigPublishHook,
  ConfigSaveOptions,
  ConfigStoreContract,
  ConfigStoreMeta,
  RuntimeConfigObject,
  RuntimeConfigRepository,
  RuntimeConfigSnapshot,
  RuntimeConfigUpdater,
} from "./types.js"

type ConfigRecord = Record<string, unknown>
type Config = ConfigRecord
type BackupRow = {
  fileName: string
  reason: string
  createdAt: string
  modifiedAt: string
  size: number
  kind: "package" | "legacy" | "quarantined" | "unreadable"
  format: string
  restorable: boolean
  hasRuntimeConfig: boolean
  sqliteAvailable: boolean | null
  counts: Record<string, number>
  itemCount: number
  error?: string
}
type LoadError = Record<string, string>
type BackupOptions = { validateCandidate?: (current: RuntimeConfigSnapshot, candidate: RuntimeConfigObject) => Promise<void> | void; beforeSave?: (sqliteConfig: unknown) => Promise<void> | void }

const pluginRootOverride = String(process.env.YUI_CHAT_PLUGIN_ROOT || "").trim()
/** 插件源码与资源根目录；编译产物通过环境变量保持与源码相同的数据定位。 */
export const pluginRoot = pluginRootOverride
  ? path.resolve(pluginRootOverride)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const yunzaiRoot = path.resolve(pluginRoot, "../..")

const runtimeRootValue = String(process.env.YUI_CHAT_RUNTIME_ROOT || "").trim()
/** 显式隔离的测试运行根；生产未设置时保持宿主既有目录。 */
export const runtimeRoot = runtimeRootValue ? path.resolve(runtimeRootValue) : ""
export const dataDir = runtimeRoot ? path.join(runtimeRoot, "data/yui-chat") : path.join(yunzaiRoot, "data/yui-chat")
export const configBackupDir = path.join(dataDir, "backups")
export const cacheDir = runtimeRoot ? path.join(runtimeRoot, "cache") : path.join(pluginRoot, "cache")
export const tempDir = path.join(cacheDir, "temp")

const backupMaxFilesFallback = 3
const backupMaxAgeDaysFallback = 30
const configBackupFormat = "yui-chat-config-backup-v2"
const preservedBackupReasons = new Set(["invalid"])
const secretKeyParts = new Set([
  "authorization", "cookie", "cookies", "credential", "credentials",
  "password", "passwords", "secret", "secrets", "token", "tokens", "auth",
])
const noConfigOverride = Symbol("no-config-override")
const configPublishHooks = new Set<ConfigPublishHook>()

function isObject(value: unknown): value is ConfigRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  return isObject(error) ? String(error.code || "") : ""
}

function recordProperty(parent: ConfigRecord, key: string): ConfigRecord {
  if (!isObject(parent[key])) parent[key] = {}
  return parent[key] as ConfigRecord
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numberValue)))
}

function resolveBackupRetention(config: Config, overrides: ConfigRecord = {}): { maxFiles: number; maxAgeDays: number } {
  const system = isObject(config.system) ? config.system : {}
  const configured = isObject(system.backups) ? system.backups : {}
  return {
    maxFiles: boundedInteger(overrides.maxFiles ?? configured.maxFiles, backupMaxFilesFallback, 3, 1000),
    maxAgeDays: boundedInteger(overrides.maxAgeDays ?? configured.maxAgeDays, backupMaxAgeDaysFallback, 30, 3650),
  }
}

/** 递归合并默认配置和用户覆盖项；数组按整数组替换，避免索引式合并产生脏配置。 */
export function mergeConfig(base: unknown, override: unknown): unknown {
  if (Array.isArray(base)) return Array.isArray(override) ? clone(override) : clone(base)
  if (!isObject(base)) return override === undefined ? base : clone(override)
  const out: ConfigRecord = { ...base }
  if (!isObject(override)) return out
  for (const [key, value] of Object.entries(override)) out[key] = mergeConfig(base[key], value)
  return out
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (!isObject(left) || !isObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
}

function configOverride(value: unknown, defaultValue: unknown): unknown | typeof noConfigOverride {
  if (sameJsonValue(value, defaultValue)) return noConfigOverride
  if (Array.isArray(value) || !isObject(value)) return clone(value)
  if (!isObject(defaultValue)) return clone(value)
  const out: ConfigRecord = {}
  for (const [key, child] of Object.entries(value)) {
    const override = configOverride(child, defaultValue[key])
    if (override !== noConfigOverride) out[key] = override
  }
  return Object.keys(out).length ? out : noConfigOverride
}

/** 磁盘只保存相对默认值发生变化的覆盖项。 */
export function extractConfigOverrides(config: unknown): ConfigRecord {
  const override = configOverride(config, defaults)
  return override === noConfigOverride || !isObject(override) ? {} : override
}

function normalizeModelRoutingDefaults(config: Config): Config {
  recordProperty(config, "chat")
  const modelTasks = recordProperty(config, "modelTasks")
  // 图片生成的开关、数量与超时已收束到 generate_image 工具运行变量；
  // 启动时直接清理旧的 response 配置，避免两套设置产生歧义。
  if (isObject(config.response)) delete config.response.imageGeneration
  if (isObject(modelTasks.imageGeneration)) delete modelTasks.imageGeneration.maxCount
  delete recordProperty(config, "chat").defaultWorkflow
  delete config.workflows
  const knowledge = recordProperty(config, "knowledge")
  const retrieval = recordProperty(knowledge, "retrieval")
  for (const key of ["rerankCallsPerConversation", "rerankCallsPerDay"]) delete retrieval[key]
  for (const key of ["enrichment", "excludedPlugins", "excludedCommands", "exclusionRules", "dynamicCapture", "capturePrivate", "captureGroups", "maxEvents", "flushDelayMs"]) delete knowledge[key]
  const defaultTasks: ConfigRecord = isObject(defaults.modelTasks) ? defaults.modelTasks : {}
  if (!isObject(modelTasks.replyer)) modelTasks.replyer = clone(defaultTasks.replyer || {})
  if (!isObject(modelTasks.imageGeneration)) modelTasks.imageGeneration = clone(defaultTasks.imageGeneration || { purpose: "image", modelList: [], selectionStrategy: "fallback" })
  if (isObject(modelTasks.imageGeneration) && !String(modelTasks.imageGeneration.purpose || "").trim()) modelTasks.imageGeneration.purpose = "image"
  delete modelTasks.commandHelper
  delete modelTasks.vision_caption
  for (const provider of Array.isArray(config.apiProviders) ? config.apiProviders : []) {
    if (isObject(provider) && provider.type === "typesafe") provider.type = "systemone"
  }
  const models = Array.isArray(config.models) ? config.models : []
  for (const value of models) {
    if (!isObject(value)) continue
    const capabilities = isObject(value.capabilities) ? value.capabilities : {}
    const declaredPurpose = String(value.purpose || "").trim().toLowerCase()
    const adapter = String(value.adapter || "").trim().toLowerCase()
    const provider = (Array.isArray(config.apiProviders) ? config.apiProviders : []).find(item => isObject(item) && item.name === value.apiProvider)
    const effectiveAdapter = adapter || (isObject(provider) ? String(provider.type || "") : "")
    const purpose = ["chat", "image", "embedding", "decision", "rerank"].includes(declaredPurpose)
      ? declaredPurpose
      : specializedAdapterPurpose(effectiveAdapter)
        ? specializedAdapterPurpose(effectiveAdapter)!
        : ["openai-images", "openai-chat-completions", "gemini-images"].includes(adapter)
          ? "image"
          : capabilities.embedding && capabilities.chat === false ? "embedding" : "chat"
    value.adapter = specializedModelAdapter(purpose, effectiveAdapter)
    if (purpose === "embedding") {
      const embedding = isObject(value.embedding) ? value.embedding : {}
      value.embedding = { ...embedding, protocol: embedding.protocol === "gemini" || effectiveAdapter === "gemini" ? "gemini" : "embeddings" }
    }
    if (purpose !== "chat") { value.visual = false; value.toolUse = false }
    value.purpose = purpose
    value.capabilities = purpose === "image" || purpose === "decision" || purpose === "rerank"
      ? { chat: false, embedding: false }
      : purpose === "embedding"
        ? { chat: false, embedding: true }
        : { chat: true, embedding: false }
    // 上下文窗口只参与文本对话预算；图片和向量请求是独立调用，不保留无效配置。
    if (purpose !== "chat") delete value.contextWindowTokens
    if (purpose !== "embedding") delete value.embedding
    else if (value.embedding !== undefined && !isObject(value.embedding)) delete value.embedding
    if (purpose !== "image") delete value.image
    if (purpose !== "rerank") delete value.rerank
  }
  const imageModels = new Set(models
    .filter(value => isObject(value) && String(value.purpose || "") === "image")
    .map(value => isObject(value) ? String(value.name || "") : "")
    .filter(Boolean))
  const rerankModels = new Set(models.filter(value => isObject(value) && value.purpose === "rerank").map(value => String((value as ConfigRecord).name || "")))
  const decisionModels = new Set(models
    .filter(value => isObject(value) && String(value.purpose || "") === "decision")
    .map(value => isObject(value) ? String(value.name || "") : "")
    .filter(Boolean))
  const embeddingOnly = new Set(models
    .filter(value => isObject(value) && isObject(value.capabilities) && value.capabilities.embedding && value.capabilities.chat === false)
    .map(value => isObject(value) ? String(value.name || "") : "")
    .filter(Boolean))
  const defaultReplyer = isObject(defaultTasks.replyer) ? defaultTasks.replyer : {}
  const defaultReplyerModelList = Array.isArray(defaultReplyer.modelList)
    ? defaultReplyer.modelList.filter(name => {
      const modelName = String(name)
      return models.some(value => isObject(value) && String(value.name || "") === modelName)
        && !imageModels.has(modelName)
        && !embeddingOnly.has(modelName)
        && !decisionModels.has(modelName) && !rerankModels.has(modelName)
    })
    : []
  for (const [taskName, taskValue] of Object.entries(modelTasks)) {
    if (!isObject(taskValue) || !Array.isArray(taskValue.modelList)) continue
    const modelList = taskValue.modelList
    const declaredTaskPurpose = String(taskValue.purpose || "").trim().toLowerCase()
    const taskPurpose = ["image", "embedding", "decision", "rerank"].includes(declaredTaskPurpose)
      ? declaredTaskPurpose
      : taskName === "imageGeneration" ? "image" : taskName === "embedding" ? "embedding" : taskName === "rerank" ? "rerank" : "chat"
    const filteredModelList = modelList.filter(name => taskPurpose === "image"
      ? imageModels.has(String(name))
      : taskPurpose === "embedding"
        ? embeddingOnly.has(String(name))
        : taskPurpose === "decision"
          ? decisionModels.has(String(name))
          : taskPurpose === "rerank" ? rerankModels.has(String(name))
          : !embeddingOnly.has(String(name)) && !imageModels.has(String(name)) && !decisionModels.has(String(name)) && !rerankModels.has(String(name)))
    taskValue.modelList = filteredModelList
    if (!filteredModelList.length && taskName === "replyer" && defaultReplyerModelList.length) {
      taskValue.modelList = [...defaultReplyerModelList]
    }
  }
  return config
}

function normalizeMessageFilters(config: Config): Config {
  const response = isObject(config.response) ? config.response : null
  if (!response) return config
  delete response.messageProcessing
  const filtering = isObject(response.messageFilters) ? response.messageFilters : null
  if (!filtering) return config
  filtering.runtimeVariables = isObject(filtering.runtimeVariables) ? filtering.runtimeVariables : {}
  const sourceFilters = Array.isArray(filtering.filters) ? filtering.filters : []
  filtering.filters = sourceFilters
    .filter(value => {
      if (!isObject(value) || !isObject(value.implementation)) return false
      return value.implementation.type === "filter" && Boolean(String(value.implementation.id || "").trim())
    })
    .map(value => {
      const filter = value as ConfigRecord
      const implementation = filter.implementation as ConfigRecord
      return {
        ...filter,
        priority: filter.priority === undefined ? 100 : Number(filter.priority),
        condition: isObject(filter.condition) ? filter.condition : {},
        implementation: {
          type: "filter",
          id: String(implementation.id).trim(),
          arguments: isObject(implementation.arguments) ? { ...implementation.arguments } : {},
        },
        onFailure: filter.onFailure || "continue",
      }
    })
  delete filtering.rules
  return config
}

function migratePersonaPrompt(config: Config): Config {
  const persona = isObject(config.persona) ? config.persona : null
  if (!persona) return config
  if (!Object.hasOwn(persona, "characterPrompt") && Object.hasOwn(persona, "systemPrompt")) {
    persona.characterPrompt = persona.systemPrompt
  }
  delete persona.systemPrompt
  return config
}

/** 日常定格的时长统一以秒保存；兼容早期的毫秒和分钟字段。 */
export function migrateStickerExpressionTimes(config: Config): Config {
  const persona = isObject(config.persona) ? config.persona : null
  const sticker = persona && isObject(persona.stickerExpression) ? persona.stickerExpression : null
  if (!sticker) return config

  const migrate = (target: ConfigRecord, secondsKey: string, legacyKey: string, factor: number): void => {
    if (target[secondsKey] === undefined && target[legacyKey] !== undefined) {
      const value = Number(target[legacyKey])
      if (Number.isFinite(value)) target[secondsKey] = value * factor
    }
    delete target[legacyKey]
  }

  const ambient = isObject(sticker.ambient) ? sticker.ambient : null
  if (ambient) migrate(ambient, "windowSeconds", "windowMs", 1 / 1000)

  const idle = isObject(sticker.idle) ? sticker.idle : null
  if (idle) {
    migrate(idle, "intervalSeconds", "intervalMinutes", 60)
    migrate(idle, "minIdleSeconds", "minIdleMinutes", 60)
  }

  migrate(sticker, "cooldownSeconds", "cooldownMs", 1 / 1000)
  migrate(sticker, "attemptIntervalSeconds", "attemptIntervalMs", 1 / 1000)
  migrate(sticker, "recentWindowSeconds", "recentWindowMinutes", 60)
  migrate(sticker, "contextTtlSeconds", "contextTtlMs", 1 / 1000)
  migrate(sticker, "intentTimeoutSeconds", "intentTimeoutMs", 1 / 1000)
  migrate(sticker, "moodDecaySeconds", "moodDecayMinutes", 60)
  const binding = isObject(sticker.binding) ? sticker.binding : null
  if (binding) {
    // 旧版本把内部包装器保存为 sticker_search；现在渠道直接绑定统一
    // Tool Registry 中的真实 MCP/Custom 工具，迁移到项目内置的 imagTag 搜图工具。
    for (const key of ["tool", "primaryTool"]) {
      if (binding[key] === "sticker_search") binding[key] = "mcp_imagTag-mcp_search_images"
    }
    if (binding.fallbackTool === "sticker_search") binding.fallbackTool = ""
  }
  return config
}

function normalizeModelToolPolicies(config: Config): void {
  const models = Array.isArray(config.models) ? config.models : []
  for (const model of models) {
    if (!isObject(model)) continue
    const toolPolicy = isObject(model.toolPolicy) ? model.toolPolicy : null
    if (toolPolicy) {
      // 能力路由已取代旧来源/策略字段；按新版配置约定直接丢弃，不猜测旧值对应的新语义。
      delete toolPolicy.sources
      delete toolPolicy.strategies
      for (const key of ["allow", "deny"] as const) {
        if (!Array.isArray(toolPolicy[key])) continue
        toolPolicy[key] = [...new Set(toolPolicy[key]
          .map(value => String(value).trim())
          .filter(value => value && !/^(?:openai|local):/.test(value)))]
      }
    }
    const responses = isObject(model.responses) ? model.responses : null
    if (!responses) continue
    delete responses.toolSearch
    if (isObject(responses.webSearch)) delete responses.webSearch.enabled
  }
}

/** 归一化已经废弃的旧字段、默认值和工具权限列表，再交给 Validator 做完整校验。 */
function normalizeConfig(config: Config): Config {
  normalizeMessageFilters(config)
  normalizeModelToolPolicies(config)
  if (isObject(config.memory) && isObject(config.memory.retrieval)) delete config.memory.retrieval.adaptiveVector
  // 旧言语风格配置退役；用户仍可选择每次生成的任务类型。
  if (isObject(config.memory) && isObject(config.memory.portrait)) {
    delete config.memory.portrait.styles
    delete config.memory.portrait.defaultStyle
  }
  const mcp = isObject(config.mcp) ? config.mcp : null
  if (mcp && isObject(mcp.servers)) {
    const removedToolExecutionFields = ["repeatable", "repeatableByAction", "idempotencyKeyFields", "idempotencyKeyFieldsByAction"]
    for (const serverValue of Object.values(mcp.servers)) {
      if (!isObject(serverValue)) continue
      delete serverValue.replyPolicy
      delete serverValue.responsePolicy
      for (const key of removedToolExecutionFields) delete serverValue[key]
      const policies = isObject(serverValue.toolPolicies) ? serverValue.toolPolicies : {}
      for (const policyValue of Object.values(policies)) {
        if (!isObject(policyValue)) continue
        delete policyValue.replyPolicy
        delete policyValue.responsePolicy
        for (const key of removedToolExecutionFields) delete policyValue[key]
      }
    }
  }
  if (isObject(config.context)) for (const key of ["enabled", "injectRecent", "maxMessages", "injectLimit", "maxMessageChars"]) delete config.context[key]
  // 输入预算改为"模型上下文窗口优先、全局预算回落"，分项预算无运行时消费，整体下线。
  if (isObject(config.chat)) delete config.chat.promptBudgets
  const response = isObject(config.response) ? config.response : null
  if (response && isObject(response.segmentation)) delete response.segmentation.llmOnly
  // 渲染配置只保留当前结构；旧开关、细分系统引擎和缓存字段直接丢弃，不再迁移。
  if (response && isObject(response.render)) {
    if (response.render.engine === "sharp-svg" || response.render.engine === "auto") delete response.render.engine
    delete response.render.markdownEngine
    delete response.render.markmapEngine
    delete response.render.chatCardAsImage
    delete response.render.helpAsImage
    delete response.render.conversationListAsImage
    delete response.render.cache
    delete response.render.cacheTtlMs
    if (isObject(response.render.system)) {
      if (response.render.system.engine === "sharp-svg" || response.render.system.engine === "auto") delete response.render.system.engine
      delete response.render.system.chatCardAsImage
      delete response.render.system.helpAsImage
      delete response.render.system.conversationListAsImage
      delete response.render.system.markdownEngine
      delete response.render.system.markmapEngine
      delete response.render.system.cache
      delete response.render.system.cacheTtlMs
    }
  }
  // 链接安全授权已经统一到 security.linkSafety；旧功能级字段直接退役，不迁移旧值。
  const mediaRecognition = isObject(config.mediaRecognition) ? config.mediaRecognition : null
  // 引用图片默认参与输入；移除已退役的独立开关。
  if (mediaRecognition) delete mediaRecognition.includeQuotedMedia
  if (mediaRecognition && isObject(mediaRecognition.remoteFetch)) delete mediaRecognition.remoteFetch.allowPrivateHosts
  if (response && isObject(response.render)) {
    if (isObject(response.render.delivery)) delete response.render.delivery.allowPrivateHosts
    if (isObject(response.render.html)) {
      delete response.render.html.enabled
      delete response.render.html.allowPrivateHosts
      delete response.render.html.allowedUrlHosts
    }
  }
  const persona = isObject(config.persona) ? config.persona : null
  if (persona) {
    for (const key of ["systemPrompt", "expression", "stateProbabilityPercent", "states", "toolOrchestrationPrompt", "groupContextPrompt", "commandGuidePrompt", "emptyReplyInstruction", "innerInstruction"]) delete persona[key]
    if (isObject(persona.output)) {
      for (const key of ["splitFirstPersonReplies", "splitMaxParts", "splitMinChars", "splitMinPartChars", "splitDelayPerCharMs", "splitMaxDelayMs", "quoteSplitReplies"]) delete persona.output[key]
    }
  }
  const web = recordProperty(config, "web")
  delete web.allowLocalhostQuickLogin
  delete web.quickLoginTtlMs
  const tools = isObject(config.tools) ? config.tools : null
  if (tools) {
    if (isObject(tools.builtin)) {
      if (isObject(tools.builtin.websiteFetch)) delete tools.builtin.websiteFetch.allowPrivateHosts
      if (isObject(tools.builtin.imageSearch)) {
        delete tools.builtin.imageSearch.allowPrivateHosts
        delete tools.builtin.imageSearch.fallbackEnabled
      }
      if (isObject(tools.builtin.webSearch)) delete tools.builtin.webSearch.fallbackEnabled
    }
    tools.enabledTools = [...new Set((Array.isArray(tools.enabledTools) ? tools.enabledTools : []).map(String).filter(Boolean))]
    const boundary = isObject(tools.boundaryAccess) ? tools.boundaryAccess : {}
    delete boundary.enabled
    if (isObject(tools.runtimeVariables) && isObject(tools.runtimeVariables.persona_punish)) delete tools.runtimeVariables.persona_punish.cooldownSeconds
    if (isObject(tools.policy)) delete tools.policy.highRiskRequiresMaster
    if (isObject(tools.builtin)) {
      delete tools.builtin.groupAdmin
      delete tools.builtin.personaPunishment
    }
    for (const bucket of ["customPackages", "skillPackages", "mcpServers"]) {
      if (!isObject(boundary[bucket])) continue
      for (const entry of Object.values(boundary[bucket])) {
        if (!isObject(entry)) continue
        delete entry.enabled
        delete entry.minRole
      }
    }
    const roles = isObject(boundary.roles) ? boundary.roles : {}
    for (const profileValue of Object.values(roles)) {
      if (!isObject(profileValue)) continue
      profileValue.allowedTools = [...new Set((Array.isArray(profileValue.allowedTools) ? profileValue.allowedTools : []).map(String).filter(Boolean))]
      profileValue.deniedTools = [...new Set((Array.isArray(profileValue.deniedTools) ? profileValue.deniedTools : []).map(String).filter(Boolean))]
      for (const key of ["enabledCategories", "allowedSources", "allowHighRisk", "allowExternalNetwork", "allowAllEnabledTools"]) delete profileValue[key]
    }
  }
  if (isObject(config.subAgent)) config.subAgent.allowedTools = [...new Set((Array.isArray(config.subAgent.allowedTools) ? config.subAgent.allowedTools : []).map(String).filter(Boolean))]
  return normalizeModelRoutingDefaults(config)
}

function keyParts(key = ""): string[] {
  return String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function isSecretKey(key = ""): boolean {
  const parts = keyParts(key)
  if (parts.some(part => secretKeyParts.has(part))) return true
  const last = parts[parts.length - 1]
  return last === "key" || (last === "id" && parts[parts.length - 2] === "key")
}

function isHeaderMapKey(key = ""): boolean {
  const parts = keyParts(key)
  return parts.includes("header") || parts.includes("headers")
}

/** 递归脱敏公共配置；密钥只在运行时边界存在，绝不进入 Web 或日志。 */
export function redactConfigSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map(item => redactConfigSecrets(item, key))
  if (isObject(value)) {
    const out: ConfigRecord = {}
    const headerMap = isHeaderMapKey(key)
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = headerMap && typeof childValue === "string" && childValue && isSecretKey(childKey) ? "********" : redactConfigSecrets(childValue, childKey)
    }
    return out
  }
  if (typeof value === "string" && isSecretKey(key) && value) return "********"
  return value
}

const redactedSecretValue = /^(?:\*{3,}|<redacted>)$/i

/** 把管理台回传的遮罩密钥还原为当前运行值；显式空字符串仍表示清除密钥。 */
export function mergeRedactedConfigSecrets(candidate: unknown, current: unknown, key = ""): unknown {
  if (typeof candidate === "string" && isSecretKey(key) && redactedSecretValue.test(candidate.trim())) {
    return typeof current === "string" && current ? current : candidate
  }
  if (Array.isArray(candidate)) {
    const previous = Array.isArray(current) ? current : []
    return candidate.map((item, index) => mergeRedactedConfigSecrets(item, previous[index], key))
  }
  if (isObject(candidate)) {
    const previous = isObject(current) ? current : {}
    const out: ConfigRecord = {}
    const headerMap = isHeaderMapKey(key)
    for (const [childKey, childValue] of Object.entries(candidate)) {
      out[childKey] = headerMap && isSecretKey(childKey) && typeof childValue === "string" && redactedSecretValue.test(childValue.trim())
        ? (typeof previous[childKey] === "string" && previous[childKey] ? previous[childKey] : childValue)
        : mergeRedactedConfigSecrets(childValue, previous[childKey], childKey)
    }
    return out
  }
  return candidate === undefined ? undefined : clone(candidate)
}

function prepareConfig(value: unknown): Config {
  const raw = clone(value || {})
  const incoming = migrateStickerExpressionTimes(migratePersonaPrompt(normalizeMessageFilters(isObject(raw) ? raw : {})))
  if (isObject(incoming.memory)) {
    for (const key of ["maxFactsPerUser", "maxEpisodesPerScope", "maxMemoriesPerOwner", "maxLoadedMemoriesPerOwner", "cacheEntries", "flushDelayMs", "promptBudgetChars", "profileFactLimit", "relevantLimit", "autoWriteBack"]) delete incoming.memory[key]
  }
  if (isObject(incoming.storage)) {
    delete incoming.storage.sqlite
    if (!Object.keys(incoming.storage).length) delete incoming.storage
  }
  const merged = clone(mergeConfig(defaults, incoming))
  const candidate = normalizeConfig(isObject(merged) ? merged : {})
  assertConfigValid(candidate as RuntimeConfigObject)
  return candidate
}

function serializeConfig(value: Config): string {
  return `${JSON.stringify(value, null, 2) ?? "null"}\n`
}

/** 配置 Store 通过单写队列持久化 SQLite 覆盖项，并发布冻结快照。 */
export class ConfigStore implements ConfigStoreContract {
  private config: Config = deepFreeze(clone(defaults)) as unknown as Config
  private loaded = false
  private lastReloadedAt = ""
  private lastLoadError: LoadError | null = null
  private dirsReady = false
  private revision = 0
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private runtimeConfigRepository: RuntimeConfigRepository | null = null

  private enqueueMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const pending = this.mutationQueue.then(operation, operation)
    this.mutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async ensureDirs(): Promise<void> {
    if (this.dirsReady) return
    await fs.mkdir(dataDir, { recursive: true })
    await fs.mkdir(configBackupDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.mkdir(tempDir, { recursive: true })
    this.dirsReady = true
  }

  private publish(candidate: Config): Config {
    this.config = deepFreeze(candidate) as unknown as Config
    this.loaded = true
    this.lastReloadedAt = new Date().toISOString()
    this.lastLoadError = null
    this.revision++
    for (const hook of configPublishHooks) {
      try {
        hook(this.config as RuntimeConfigSnapshot)
      } catch (error) {
        hostRuntime.logger?.warn?.("[yui-chat] 配置发布钩子执行失败", error)
      }
    }
    return clone(this.config)
  }

  private async repository(): Promise<RuntimeConfigRepository> {
    if (this.runtimeConfigRepository) return this.runtimeConfigRepository
    const [{ sqliteClient }, { SqliteRuntimeConfigRepository }] = await Promise.all([
      import("../core/storage/sqlite/client.js"),
      import("../core/storage/sqlite/runtime-config-repository.js"),
    ])
    const status = await sqliteClient.init()
    if (!status.available) throw new Error(`SQLite 主配置不可用，已停止加载：${status.error || "unknown"}`)
    this.runtimeConfigRepository = new SqliteRuntimeConfigRepository(sqliteClient)
    return this.runtimeConfigRepository
  }

  private async performLoad(): Promise<Config> {
    await this.ensureDirs()
    try {
      const repository = await this.repository()
      const stored = await repository.load()
      if (!stored.exists) throw new Error("SQLite 主配置记录缺失，已停止加载。")
      const overrides = clone(stored.overrides)
      migrateStoredReasoning(overrides)
      const candidate = prepareConfig(overrides)
      const normalized = extractConfigOverrides(candidate)
      if (!sameJsonValue(normalized, stored.overrides)) await repository.save(normalized as RuntimeConfigObject)
      if (this.loaded && sameJsonValue(candidate, this.config)) {
        this.lastLoadError = null
        return clone(this.config)
      }
      return this.publish(candidate)
    } catch (error) {
      this.lastLoadError = { message: errorMessage(error), time: new Date().toISOString() }
      throw error
    }
  }

  /** 返回从 SQLite 读取并校验后的可编辑配置副本。 */
  async load(): Promise<RuntimeConfigObject> {
    return this.enqueueMutation(() => this.performLoad() as Promise<RuntimeConfigObject>)
  }

  /** 获取冻结的运行快照，调用方禁止直接修改。 */
  get(): RuntimeConfigSnapshot {
    return this.config as RuntimeConfigSnapshot
  }

  /** 获取递归脱敏后的公共配置。 */
  getPublic(): RuntimeConfigObject {
    return redactConfigSecrets(this.config) as RuntimeConfigObject
  }

  validate(nextConfig: RuntimeConfigObject = this.config as RuntimeConfigObject) {
    return validateConfig(nextConfig)
  }

  meta(): ConfigStoreMeta {
    return {
      loaded: this.loaded,
      runtimeRoot,
      configBackupDir,
      lastReloadedAt: this.lastReloadedAt,
      lastLoadError: this.lastLoadError,
      revision: this.revision,
      runtimeConfigAttached: Boolean(this.runtimeConfigRepository),
    }
  }

  /** 注入配置仓库，供隔离测试和宿主接入使用。 */
  attachRuntimeConfigRepository(repository: RuntimeConfigRepository): Promise<RuntimeConfigSnapshot> {
    if (!repository || typeof repository.load !== "function" || typeof repository.save !== "function") throw new TypeError("runtime config repository must expose load() and save()")
    return this.enqueueMutation(async () => {
      const previous = this.runtimeConfigRepository
      this.runtimeConfigRepository = repository
      try {
        return await this.performLoad() as RuntimeConfigSnapshot
      } catch (error) {
        this.runtimeConfigRepository = previous
        throw error
      }
    })
  }

  private async performSave(nextConfig: Config): Promise<Config> {
    const candidate = prepareConfig(nextConfig)
    const repository = await this.repository()
    const stored = await repository.load()
    if (!stored.exists) throw new Error("SQLite 主配置记录缺失，已停止保存。")
    const overrides = extractConfigOverrides(candidate)
    if (!sameJsonValue(overrides, stored.overrides)) await repository.save(overrides as RuntimeConfigObject)
    return this.publish(candidate)
  }

  /** 完整替换配置；只有数据库提交成功后才发布快照。 */
  save(nextConfig?: RuntimeConfigObject, _options: ConfigSaveOptions = {}): Promise<RuntimeConfigSnapshot> {
    const snapshot = nextConfig === undefined ? undefined : clone(nextConfig) as Config
    return this.enqueueMutation(async () => {
      if (!this.loaded) await this.performLoad()
      return this.performSave(snapshot || clone(this.config)) as Promise<RuntimeConfigSnapshot>
    })
  }

  /** 在最新 SQLite 快照上串行执行更新器，防止并发请求互相覆盖。 */
  update(mutator: RuntimeConfigUpdater, _options: ConfigSaveOptions = {}): Promise<RuntimeConfigSnapshot> {
    if (typeof mutator !== "function") throw new TypeError("config updater must be a function")
    return this.enqueueMutation(async () => {
      await this.performLoad()
      const draft = clone(this.config) as RuntimeConfigObject
      const result = await mutator(draft)
      return this.performSave((result === undefined ? draft : result) as Config) as Promise<RuntimeConfigSnapshot>
    })
  }

  private async performBackup(reason = "manual", retention?: ConfigRecord, extras: ConfigRecord = {}): Promise<string> {
    await this.ensureDirs()
    const safeReason = String(reason || "manual").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "manual"
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const suffix = crypto.randomBytes(4).toString("hex")
    const backupFile = path.join(configBackupDir, `config.${safeReason}.${stamp}-${suffix}.json`)
    const config = extractConfigOverrides(this.config)
    const contents = serializeConfig({ format: configBackupFormat, createdAt: new Date().toISOString(), config, sqliteConfig: extras.sqliteConfig || null })
    await writeFileAtomic(backupFile, contents)
    await this.pruneBackups(retention).catch(error => hostRuntime.logger?.warn?.("[yui-chat] 配置备份清理失败", error))
    return backupFile
  }

  private async pruneBackups(options: ConfigRecord = {}): Promise<{ removed: number; kept: number; maxFiles: number; maxAgeDays: number }> {
    const { maxFiles, maxAgeDays } = resolveBackupRetention(this.config, options)
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const rows = await this.listBackups({ limit: 0 })
    const automatic = rows.filter(item => !preservedBackupReasons.has(item.reason))
    const removals = automatic.filter((item, index) => {
      const modifiedAt = Date.parse(item.modifiedAt || "")
      return index >= maxFiles && Number.isFinite(modifiedAt) && modifiedAt < cutoff
    })
    await Promise.all(removals.map(item => fs.unlink(this.backupPath(item.fileName)).catch(error => { if (errorCode(error) !== "ENOENT") throw error })))
    return { removed: removals.length, kept: rows.length - removals.length, maxFiles, maxAgeDays }
  }

  /** 手动清理配置备份，不会隐式创建新备份。 */
  pruneBackupsNow(options: ConfigRecord = {}): Promise<{ removed: number; kept: number; maxFiles: number; maxAgeDays: number }> {
    return this.enqueueMutation(() => this.pruneBackups(options))
  }

  backupRetention(): { maxFiles: number; maxAgeDays: number } {
    return resolveBackupRetention(this.config)
  }

  /** 仅在管理员显式调用时创建配置包。 */
  backup(reason = "manual", extras: ConfigRecord = {}): Promise<string> {
    return this.enqueueMutation(() => this.performBackup(reason, undefined, clone(extras)))
  }

  backupPath(fileName = ""): string {
    const baseName = path.basename(String(fileName || ""))
    if (!/^config\.[a-z0-9_-]+\.\d{4}-\d{2}-\d{2}T.+\.json$/i.test(baseName)) throw new Error("非法配置备份文件名。")
    return path.join(configBackupDir, baseName)
  }

  /** 删除管理员明确指定的单个配置包；路径始终收敛到备份目录中的合法文件名。 */
  deleteBackup(fileName: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.ensureDirs()
      const file = this.backupPath(fileName)
      try {
        await fs.unlink(file)
        return true
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false
        throw error
      }
    })
  }

  async listBackups(options: { limit?: number; inspect?: boolean } = {}): Promise<BackupRow[]> {
    await this.ensureDirs()
    const entries = await fs.readdir(configBackupDir, { withFileTypes: true }).catch(() => [])
    const rows: BackupRow[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !/^config\.[a-z0-9_-]+\..+\.json$/i.test(entry.name)) continue
      const file = path.join(configBackupDir, entry.name)
      try {
        const stat = await fs.stat(file)
        const match = entry.name.match(/^config\.([a-z0-9_-]+)\.(.+)\.json$/i)
        const reason = match?.[1] || "manual"
        let kind: BackupRow["kind"] = reason === "invalid" ? "quarantined" : "legacy"
        let format = ""
        let createdAt = stat.birthtimeMs ? new Date(stat.birthtimeMs).toISOString() : ""
        let restorable = reason !== "invalid"
        let hasRuntimeConfig = false
        let sqliteAvailable: boolean | null = null
        let counts: Record<string, number> = {}
        let error = ""
        if (options.inspect === true) {
          try {
            const payload: unknown = JSON.parse(await fs.readFile(file, "utf8"))
            if (!isObject(payload)) restorable = false
            else {
              format = String(payload.format || "")
              if (format === configBackupFormat) {
                kind = "package"
                hasRuntimeConfig = isObject(payload.config)
                restorable = restorable && hasRuntimeConfig
              }
              if (typeof payload.createdAt === "string" && payload.createdAt) createdAt = payload.createdAt
              if (isObject(payload.sqliteConfig)) {
                sqliteAvailable = payload.sqliteConfig.available === true
                const tables = isObject(payload.sqliteConfig.tables) ? payload.sqliteConfig.tables : {}
                counts = Object.fromEntries(Object.entries(tables).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]))
              }
            }
          } catch (readError) {
            kind = "unreadable"
            restorable = false
            error = errorMessage(readError)
          }
        }
        rows.push({
          fileName: entry.name,
          reason,
          createdAt,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
          size: stat.size,
          kind,
          format,
          restorable,
          hasRuntimeConfig,
          sqliteAvailable,
          counts,
          itemCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
          ...(error ? { error } : {}),
        })
      } catch {
        // 单个备份在并发清理期间消失时忽略该条，不影响其余列表。
      }
    }
    rows.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    const limit = Math.max(0, Number(options.limit ?? 30) || 0)
    return limit ? rows.slice(0, limit) : rows
  }

  /** 从管理员指定的配置包恢复；是否恢复其中的 SQLite 白名单由调用方显式决定。 */
  restoreBackup(fileName: string, options: BackupOptions = {}): Promise<RuntimeConfigSnapshot> {
    return this.enqueueMutation(async () => {
      await this.ensureDirs()
      const file = this.backupPath(fileName)
      const payload: unknown = JSON.parse(await fs.readFile(file, "utf8"))
      const packaged = isObject(payload) && payload.format === configBackupFormat
      const restored = packaged && isObject(payload) ? payload.config : payload
      migrateStoredReasoning(restored)
      const candidate = prepareConfig(restored)
      if (options.validateCandidate) await options.validateCandidate(this.get(), candidate as RuntimeConfigObject)
      if (packaged && options.beforeSave && isObject(payload)) await options.beforeSave(clone(payload.sqliteConfig))
      return this.performSave(candidate) as Promise<RuntimeConfigSnapshot>
    })
  }
}

export const configStore = new ConfigStore()

/** 注册配置发布观察者；观察者只能读取快照，注销函数可用于测试和生命周期清理。 */
export function registerConfigPublishHook(hook: ConfigPublishHook): () => boolean {
  if (typeof hook !== "function") throw new TypeError("config publish hook must be a function")
  configPublishHooks.add(hook)
  return () => configPublishHooks.delete(hook)
}
