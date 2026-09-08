import { isLogLevel } from "./logging.js"
import { isToolDeliveryMode, isToolExecutionEffect, isToolRepeatPolicy, isToolRetryPolicy, isToolRiskLevel } from "../tools/support/contract.js"
import type { UnknownRecord } from "../core/message/types.js"
import { isValidAllowedHostPattern, parseHttpUrl } from "../core/network/link-safety-policy.js"
import { parseCronExpression } from "../core/scheduling/cron.js"

export type ValidationLevel = "error" | "warn"

export interface ValidationIssue {
  level: ValidationLevel
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

interface ValidationOptions {
  min?: number
  max?: number
  level?: ValidationLevel
  integer?: boolean
}

interface ConfigSection extends UnknownRecord {
  backups?: ConfigSection
  sources?: ConfigSection
  access?: ConfigSection
  execution?: ConfigSection
  background?: ConfigSection
  promptBudgets?: ConfigSection
  sqlite?: ConfigSection
  segmentation?: ConfigSection
  messageFilters?: ConfigSection
  render?: ConfigSection
  mediaThumbnail?: ConfigSection
  delivery?: ConfigSection
  html?: ConfigSection
  viewport?: ConfigSection
  embedding?: ConfigSection
  capabilities?: ConfigSection
  reasoning?: ConfigSection
  retrieval?: ConfigSection
  groupCapture?: ConfigSection
  consolidation?: ConfigSection
  builtin?: ConfigSection
  websiteFetch?: ConfigSection
  imageSearch?: ConfigSection
  webSearch?: ConfigSection
  scheduleTask?: ConfigSection
  blockUser?: ConfigSection
  policy?: ConfigSection
  boundaryAccess?: ConfigSection
  promptSelection?: ConfigSection
  roles?: ConfigSection
  customPackages?: ConfigSection
  skillPackages?: ConfigSection
  mcpServers?: ConfigSection
  servers?: ConfigSection
  toolPolicies?: ConfigSection
  promptCount?: ConfigSection
  implementation?: ConfigSection
  condition?: ConfigSection
  retention?: ConfigSection
  indexing?: ConfigSection
  commandRetrieval?: ConfigSection
  history?: ConfigSection
  remoteFetch?: ConfigSection
  trigger?: ConfigSection
  ambient?: ConfigSection
  poke?: ConfigSection
  initiativeGreeting?: ConfigSection
  [key: string]: unknown
}

interface ConfigRecord extends ConfigSection {
  web?: ConfigSection
  system?: ConfigSection
  skills?: ConfigSection
  chat?: ConfigSection
  modelTasks?: ConfigSection
  tools?: ConfigSection
  mcp?: ConfigSection
  subAgent?: ConfigSection
  storage?: ConfigSection
  response?: ConfigSection
  context?: ConfigSection
  memory?: ConfigSection
  knowledge?: ConfigSection
  mediaRecognition?: ConfigSection
  persona?: ConfigSection
  logging?: ConfigSection
}

const adapterIds = new Set(["mock", "openai-compatible", "openai-responses", "qwen", "gemini", "claude", "chatglm"])
const authTypes = new Set(["bearer", "none", "query", "x-api-key", "api-key", "custom-header"])
const selectionStrategies = new Set(["sequential", "random", "fallback"])
const boundaryRoles = new Set(["user", "groupAdmin", "groupOwner", "master"])
const renderEngines = new Set(["html", "svg"])
const pokeResponseModes = new Set(["ai", "fallback", "ai-with-fallback"])
const segmentationIntervalMethods = new Set(["random", "log"])
const segmentationModes = new Set(["regex", "natural"])
const reasoningTargets = new Set(["auto", "openai", "deepseek", "claude"])
const reasoningEfforts = new Set(["low", "medium", "high"])
const modelToolPolicyModes = new Set(["inherit", "allowlist", "denylist"])
const modelToolSources = new Set(["auto", "hosted", "local", "disabled"])
const modelWebSearchStrategies = new Set(["preferred", "fallback", "parallel"])

function isObject(value: unknown): value is ConfigSection {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 从配置边界安全读取嵌套对象；校验器只消费未知输入，不把它当成可信配置类型。 */
function section(value: unknown): UnknownRecord {
  return isObject(value) ? value : {}
}

function add(issues: ValidationIssue[], level: ValidationLevel, path: string, message: string): void {
  issues.push({ level, path, message })
}

function validateExecution(issues: ValidationIssue[], path: string, execution: unknown = {}): void {
  if (execution === undefined) return
  if (!isObject(execution)) {
    add(issues, "error", path, `${path} 必须是对象`)
    return
  }
  if (execution.effect !== undefined && !isToolExecutionEffect(execution.effect)) add(issues, "error", `${path}.effect`, `未知执行效果：${String(execution.effect)}`)
  if (execution.repeatPolicy !== undefined && !isToolRepeatPolicy(execution.repeatPolicy)) add(issues, "error", `${path}.repeatPolicy`, `未知重复策略：${String(execution.repeatPolicy)}`)
  if (execution.retryPolicy !== undefined && !isToolRetryPolicy(execution.retryPolicy)) add(issues, "error", `${path}.retryPolicy`, `未知重试策略：${String(execution.retryPolicy)}`)
  for (const field of ["supportsCount", "polling"]) {
    if (execution[field] !== undefined && typeof execution[field] !== "boolean") add(issues, "error", `${path}.${field}`, `${path}.${field} 必须是布尔值`)
  }
  for (const field of ["countField", "operationFamily"]) {
    const value = execution[field]
    if (value !== undefined && (typeof value !== "string" || !value.trim())) add(issues, "error", `${path}.${field}`, `${path}.${field} 必须是非空字符串`)
  }
  for (const field of ["maxCount", "maxAttempts", "timeoutMs"]) {
    if (execution[field] !== undefined && (!Number.isFinite(Number(execution[field])) || Number(execution[field]) < 0)) add(issues, "error", `${path}.${field}`, `${path}.${field} 必须是非负数字`)
  }
  for (const field of ["background", "parallelSafe"]) {
    if (execution[field] !== undefined && typeof execution[field] !== "boolean") add(issues, "error", `${path}.${field}`, `${path}.${field} 必须是布尔值`)
  }
  for (const field of ["maxPolls", "minPollIntervalMs"]) {
    if (execution[field] !== undefined && (!Number.isFinite(Number(execution[field])) || Number(execution[field]) < 0)) add(issues, "error", `${path}.${field}`, `${path}.${field} 必须是非负数字`)
  }
  for (const field of ["targetFields", "operationFields"]) {
    const value = execution[field]
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()))) {
      add(issues, "error", `${path}.${field}`, `${path}.${field} 必须只包含非空字符串`)
    }
  }
  const promptCount = execution.promptCount
  if (promptCount !== undefined) {
    if (!isObject(promptCount)) add(issues, "error", `${path}.promptCount`, `${path}.promptCount 必须是对象`)
    else {
      for (const field of ["keywords", "units"]) {
        const value = promptCount[field]
        if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()))) {
          add(issues, "error", `${path}.promptCount.${field}`, `${path}.promptCount.${field} 必须只包含非空字符串`)
        }
      }
      if (promptCount.maxClauses !== undefined) positiveNumber(issues, `${path}.promptCount.maxClauses`, promptCount.maxClauses, { min: 1, max: 20, integer: true })
    }
  }
}

function validateExecutionByAction(issues: ValidationIssue[], path: string, value: unknown): void {
  if (value === undefined) return
  if (!isObject(value)) {
    add(issues, "error", path, `${path} 必须是对象`)
    return
  }
  for (const [action, execution] of Object.entries(value)) validateExecution(issues, `${path}.${action}`, execution)
}

function requireObject(issues: ValidationIssue[], _config: unknown, path: string, value: unknown): void {
  if (!isObject(value)) add(issues, "error", path, `${path} 必须是对象`)
}

function requireArray(issues: ValidationIssue[], path: string, value: unknown): void {
  if (!Array.isArray(value)) add(issues, "error", path, `${path} 必须是数组`)
}

function validateToolExecutionPolicy(issues: ValidationIssue[], path: string, value: unknown = {}): void {
  const source = isObject(value) ? value : {}
  validateExecution(issues, `${path}.execution`, source.execution)
  validateExecutionByAction(issues, `${path}.executionByAction`, source.executionByAction)
}

function positiveNumber(issues: ValidationIssue[], path: string, value: unknown, { min = 0, max = Infinity, level = "error", integer = false }: ValidationOptions = {}): void {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    add(issues, level, path, `${path} 必须是 ${min} 到 ${max === Infinity ? "无限制" : max} 之间的数字`)
  }
}

function collectNamed(issues: ValidationIssue[], path: string, list: unknown = [], nameField = "name"): Set<string> {
  const names = new Set<string>()
  for (const [index, item] of asArray(list).entries()) {
    if (!isObject(item)) {
      add(issues, "error", `${path}.${index}`, `${path}.${index} 必须是对象`)
      continue
    }
    const name = String(item[nameField] || "").trim()
    if (!name) {
      add(issues, "error", `${path}.${index}.${nameField}`, `${path}.${index}.${nameField} 不能为空`)
      continue
    }
    if (names.has(name)) add(issues, "error", `${path}.${index}.${nameField}`, `${path} 中存在重复 ${nameField}：${name}`)
    names.add(name)
  }
  return names
}

function validateWeb(config: ConfigRecord, issues: ValidationIssue[]): void {
  const web = section(config.web)
  requireObject(issues, config, "web", config.web)
  const mountPath = String(web.mountPath || "")
  if (!/^\/[A-Za-z0-9._~!$&()*+,;=:@%/-]+$/.test(mountPath)) {
    add(issues, "error", "web.mountPath", "web.mountPath 必须是以 / 开头且只包含安全 URL 路径字符的路由路径")
  }
  if (mountPath === "/") add(issues, "error", "web.mountPath", "web.mountPath 不能挂载到根路径 /")
  const authToken = String(web.authToken || "").trim()
  if (authToken && (authToken.length < 16 || authToken.length > 512)) {
    add(issues, "error", "web.authToken", "web.authToken 留空表示禁用静态登录；启用时长度必须为 16–512 个字符")
  }
  positiveNumber(issues, "web.port", web.port, { min: 1, max: 65535 })
  positiveNumber(issues, "web.accessTokenTtlMs", web.accessTokenTtlMs, { min: 60000 })
  const publicBaseUrls = web.publicBaseUrls
  if (publicBaseUrls !== undefined && !Array.isArray(publicBaseUrls)) {
    add(issues, "error", "web.publicBaseUrls", "web.publicBaseUrls 必须是数组")
  }
  const publicUrls: Array<[string, unknown]> = [
    ...(web.publicBaseUrl ? [["web.publicBaseUrl", web.publicBaseUrl] as [string, unknown]] : []),
    ...(Array.isArray(publicBaseUrls) ? publicBaseUrls.map((value, index) => [`web.publicBaseUrls.${index}`, value] as [string, unknown]) : []),
  ]
  for (const [path, value] of publicUrls) {
    const url = parseHttpUrl(value)
    if (!url || url.search || url.hash) {
      add(issues, "error", path, "Web 服务器地址前缀必须是无内嵌凭证、查询参数和锚点的 http/https URL")
    }
  }
}

function validateSystem(config: ConfigRecord, issues: ValidationIssue[]): void {
  const backups = section(section(config.system).backups)
  requireObject(issues, config, "system", config.system)
  requireObject(issues, config.system, "system.backups", section(config.system).backups)
  const values: Array<[string, unknown, number, number]> = [
    ["system.backups.maxFiles", backups.maxFiles, 3, 1000],
    ["system.backups.maxAgeDays", backups.maxAgeDays, 30, 3650],
  ]
  for (const [path, value, min, max] of values) {
    positiveNumber(issues, path, value, { min, max })
    if (Number.isFinite(Number(value)) && !Number.isInteger(Number(value))) {
      add(issues, "error", path, `${path} 必须是整数`)
    }
  }
}

function validateLinkSafety(config: ConfigRecord, issues: ValidationIssue[]): void {
  const security = config.security
  if (!isObject(security)) {
    add(issues, "error", "security", "security 必须是对象")
    return
  }
  const safety = security.linkSafety
  if (!isObject(safety)) {
    add(issues, "error", "security.linkSafety", "security.linkSafety 必须是对象")
    return
  }
  for (const field of ["allowPrivateHosts", "trustedPrivateDnsBypass"]) {
    if (safety[field] !== undefined && typeof safety[field] !== "boolean") {
      add(issues, "error", `security.linkSafety.${field}`, `${field} 必须是布尔值`)
    }
  }
  const hosts = safety.screenshotAllowedHosts
  if (!Array.isArray(hosts)) {
    add(issues, "error", "security.linkSafety.screenshotAllowedHosts", "screenshotAllowedHosts 必须是域名数组")
  } else {
    if (hosts.length > 64) add(issues, "error", "security.linkSafety.screenshotAllowedHosts", "screenshotAllowedHosts 最多配置 64 个域名")
    const seenHosts = new Set<string>()
    for (const [index, value] of hosts.entries()) {
      const host = typeof value === "string" ? value.trim().toLowerCase() : ""
      if (!isValidAllowedHostPattern(host)) {
        add(issues, "error", `security.linkSafety.screenshotAllowedHosts.${index}`, "必须是 *、hostname 或 *.example.com，不得包含协议、端口或路径")
        continue
      }
      if (seenHosts.has(host)) add(issues, "warn", `security.linkSafety.screenshotAllowedHosts.${index}`, `重复的 URL 截图允许域名：${host}`)
      seenHosts.add(host)
    }
  }
  if (safety.allowPrivateHosts === true) add(issues, "warn", "security.linkSafety.allowPrivateHosts", "链接安全策略允许访问任意私网地址，请仅在受控网络中启用")
}

function validateSkills(config: ConfigRecord, issues: ValidationIssue[]): void {
  if (config.skills === undefined) return
  const skills = section(config.skills)
  requireObject(issues, config, "skills", config.skills)
  if (skills.disabled !== undefined) requireArray(issues, "skills.disabled", skills.disabled)
  if (skills.sources !== undefined && !isObject(skills.sources)) add(issues, "error", "skills.sources", "skills.sources 必须是对象")
}

function validateProviders(config: ConfigRecord, issues: ValidationIssue[]): void {
  requireArray(issues, "apiProviders", config.apiProviders)
  requireArray(issues, "models", config.models)
  const providerNames = collectNamed(issues, "apiProviders", config.apiProviders)
  const modelNames = collectNamed(issues, "models", config.models)
  const channelIds = collectNamed(issues, "channels", config.channels || [], "id")

  for (const [index, provider] of asArray(config.apiProviders).entries()) {
    if (!isObject(provider)) continue
    const type = String(provider.type || "mock")
    if (!adapterIds.has(type)) add(issues, "warn", `apiProviders.${index}.type`, `未知 provider type：${type}`)
    const authType = String(provider.authType || "")
    if (authType && !authTypes.has(authType)) {
      add(issues, "error", `apiProviders.${index}.authType`, `未知 authType：${authType}`)
    }
    if (provider.headers !== undefined && !isObject(provider.headers)) add(issues, "error", `apiProviders.${index}.headers`, "headers 必须是对象")
    if (provider.query !== undefined && !isObject(provider.query)) add(issues, "error", `apiProviders.${index}.query`, "query 必须是对象")
  }

  for (const [index, model] of asArray(config.models).entries()) {
    if (!isObject(model)) continue
    const providerName = String(model.apiProvider || "")
    const modelName = String(model.name || index)
    if (providerName && !providerNames.has(providerName)) {
      add(issues, "error", `models.${index}.apiProvider`, `模型 ${modelName} 引用了不存在的 provider：${providerName}`)
    }
    const provider = asArray(config.apiProviders).map(section).find(item => String(item.name || "") === providerName)
    const adapter = String(model.adapter || provider?.type || "")
    if (adapter && !adapterIds.has(adapter)) add(issues, "warn", `models.${index}.adapter`, `未知模型 adapter：${adapter}`)
    if (!model.modelIdentifier && !model.model) {
      add(issues, "warn", `models.${index}.modelIdentifier`, `模型 ${modelName} 未声明 modelIdentifier`)
    }
    if (model.params !== undefined && !isObject(model.params)) add(issues, "error", `models.${index}.params`, "params 必须是对象")
    if (model.toolPolicy !== undefined) {
      if (!isObject(model.toolPolicy)) add(issues, "error", `models.${index}.toolPolicy`, "toolPolicy 必须是对象")
      else {
        const toolPolicy = section(model.toolPolicy)
        const mode = String(toolPolicy.mode || "inherit")
        if (!modelToolPolicyModes.has(mode)) add(issues, "error", `models.${index}.toolPolicy.mode`, `未知工具范围策略：${mode}`)
        for (const key of ["allow", "deny"]) {
          const value = toolPolicy[key]
          if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()))) {
            add(issues, "error", `models.${index}.toolPolicy.${key}`, `${key} 必须是非空字符串数组`)
          } else if (Array.isArray(value) && value.some(item => /^(?:openai|local):/.test(String(item)))) {
            add(issues, "error", `models.${index}.toolPolicy.${key}`, `${key} 只接受能力或工具 ID，不接受 openai: / local: 实现 ID`)
          }
        }
        if (toolPolicy.sources !== undefined) {
          add(issues, "error", `models.${index}.toolPolicy.sources`, "sources 已移除，请使用 toolPolicy.routes")
        }
        if (toolPolicy.strategies !== undefined) {
          add(issues, "error", `models.${index}.toolPolicy.strategies`, "strategies 已移除，请使用 toolPolicy.routes.web_search.strategy")
        }
        if (toolPolicy.routes !== undefined && !isObject(toolPolicy.routes)) {
          add(issues, "error", `models.${index}.toolPolicy.routes`, "routes 必须是对象")
        } else {
          const routes = section(toolPolicy.routes)
          for (const key of Object.keys(routes)) {
            if (!["web_search", "tool_search"].includes(key)) add(issues, "error", `models.${index}.toolPolicy.routes.${key}`, `未知能力路由：${key}`)
          }
          for (const key of ["web_search", "tool_search"]) {
            const route = routes[key]
            if (route !== undefined && !isObject(route)) {
              add(issues, "error", `models.${index}.toolPolicy.routes.${key}`, `${key} 路由必须是对象`)
              continue
            }
            const value = section(route)
            if (value.source !== undefined && !modelToolSources.has(String(value.source))) {
              add(issues, "error", `models.${index}.toolPolicy.routes.${key}.source`, `未知工具来源：${String(value.source)}`)
            }
            if (key === "web_search" && value.strategy !== undefined && !modelWebSearchStrategies.has(String(value.strategy))) {
              add(issues, "error", `models.${index}.toolPolicy.routes.web_search.strategy`, `未知 Web Search 执行策略：${String(value.strategy)}`)
            }
            if (key === "tool_search" && value.strategy !== undefined) {
              add(issues, "error", `models.${index}.toolPolicy.routes.tool_search.strategy`, "tool_search 暂不支持 strategy")
            }
          }
        }
      }
    }
    if (model.responses !== undefined) {
      if (!isObject(model.responses)) add(issues, "error", `models.${index}.responses`, "responses 必须是对象")
      else {
        const responses = section(model.responses)
        if (responses.stateMode !== undefined && !["auto", "local", "previous_response_id"].includes(String(responses.stateMode))) {
          add(issues, "error", `models.${index}.responses.stateMode`, `未知 Responses 上下文模式：${String(responses.stateMode)}`)
        }
        if (responses.store !== undefined && typeof responses.store !== "boolean") add(issues, "error", `models.${index}.responses.store`, "store 必须是布尔值")
        if (responses.parallelToolCalls !== undefined && typeof responses.parallelToolCalls !== "boolean") add(issues, "error", `models.${index}.responses.parallelToolCalls`, "parallelToolCalls 必须是布尔值")
        if (responses.toolSearch !== undefined) add(issues, "error", `models.${index}.responses.toolSearch`, "toolSearch 已移至 toolPolicy.routes.tool_search")
        for (const key of ["webSearch", "fileSearch"]) {
          const value = responses[key]
          if (value !== undefined && !isObject(value)) add(issues, "error", `models.${index}.responses.${key}`, `${key} 必须是对象`)
          else if (key === "webSearch" && isObject(value) && value.enabled !== undefined) add(issues, "error", `models.${index}.responses.webSearch.enabled`, "webSearch.enabled 已移至 toolPolicy.routes.web_search.source")
          else if (key === "fileSearch" && isObject(value) && value.enabled !== undefined && typeof value.enabled !== "boolean") add(issues, "error", `models.${index}.responses.fileSearch.enabled`, "enabled 必须是布尔值")
        }
        const fileSearch = section(responses.fileSearch)
        if (fileSearch.vectorStoreIds !== undefined && (!Array.isArray(fileSearch.vectorStoreIds) || fileSearch.vectorStoreIds.some(value => typeof value !== "string" || !value.trim()))) {
          add(issues, "error", `models.${index}.responses.fileSearch.vectorStoreIds`, "vectorStoreIds 必须是非空字符串数组")
        }
        if (fileSearch.enabled === true && (!Array.isArray(fileSearch.vectorStoreIds) || !fileSearch.vectorStoreIds.length)) {
          add(issues, "error", `models.${index}.responses.fileSearch.vectorStoreIds`, "启用 file_search 时至少需要一个 Vector Store ID")
        }
        if (fileSearch.maxNumResults !== undefined) positiveNumber(issues, `models.${index}.responses.fileSearch.maxNumResults`, fileSearch.maxNumResults, { min: 1, max: 50 })
      }
    }
    if (model.capabilities !== undefined && !isObject(model.capabilities)) add(issues, "error", `models.${index}.capabilities`, "capabilities 必须是对象")
    if (model.contextWindowTokens !== undefined) positiveNumber(issues, `models.${index}.contextWindowTokens`, model.contextWindowTokens, { min: 1024, max: 10000000 })
    const embedding = model.embedding
    if (embedding !== undefined) {
      if (!isObject(embedding)) add(issues, "error", `models.${index}.embedding`, "embedding 必须是对象")
      else {
        positiveNumber(issues, `models.${index}.embedding.defaultDimensions`, embedding.defaultDimensions, { min: 1, max: 100000 })
        positiveNumber(issues, `models.${index}.embedding.batchSize`, embedding.batchSize, { min: 1, max: 512 })
        positiveNumber(issues, `models.${index}.embedding.timeoutMs`, embedding.timeoutMs, { min: 1000, max: 600000 })
        const allowedDimensions = embedding.allowedDimensions
        if (allowedDimensions !== undefined && !Array.isArray(allowedDimensions)) add(issues, "error", `models.${index}.embedding.allowedDimensions`, "allowedDimensions 必须是数组")
        if (Array.isArray(allowedDimensions) && allowedDimensions.some(value => !Number.isInteger(Number(value)) || Number(value) <= 0)) add(issues, "error", `models.${index}.embedding.allowedDimensions`, "allowedDimensions 必须是正整数数组")
        if (embedding.supportsDimensionOverride !== undefined && typeof embedding.supportsDimensionOverride !== "boolean") add(issues, "error", `models.${index}.embedding.supportsDimensionOverride`, "supportsDimensionOverride 必须是布尔值")
      }
    }
    const capabilities = section(model.capabilities)
    if (capabilities.embedding === true && !isObject(embedding)) add(issues, "error", `models.${index}.embedding`, "启用 embedding 能力时必须配置 embedding 参数")
    if (model.timeoutMs !== undefined) positiveNumber(issues, `models.${index}.timeoutMs`, model.timeoutMs, { min: 1000, max: 600000 })
    if (model.stream !== undefined && typeof model.stream !== "boolean") add(issues, "error", `models.${index}.stream`, "stream 必须是布尔值")
    if (model.stream === true && !["openai-compatible", "openai-responses", "qwen", "chatglm", "gemini", "claude"].includes(adapter)) {
      add(issues, "warn", `models.${index}.stream`, `模型 ${modelName} 的 ${adapter || "当前"} 适配器暂不支持流式响应，将按非流式执行`)
    }
    const reasoning = model.reasoning
    if (reasoning !== undefined) {
      if (!isObject(reasoning)) add(issues, "error", `models.${index}.reasoning`, "reasoning 必须是对象")
      else {
        const target = String(reasoning.target || "auto").trim().toLowerCase()
        const effort = String(reasoning.effort || "").trim().toLowerCase()
        if (target && !reasoningTargets.has(target)) add(issues, "error", `models.${index}.reasoning.target`, `未知推理适配目标：${target}`)
        if (effort && !reasoningEfforts.has(effort)) add(issues, "error", `models.${index}.reasoning.effort`, `未知推理等级：${effort}`)
      }
    }
  }

  if (!isObject(config.modelTasks)) add(issues, "error", "modelTasks", "modelTasks 必须是对象")
  for (const [taskName, task] of Object.entries(config.modelTasks || {})) {
    if (!isObject(task)) {
      add(issues, "error", `modelTasks.${taskName}`, "模型任务必须是对象")
      continue
    }
    if (!Array.isArray(task.modelList)) add(issues, "error", `modelTasks.${taskName}.modelList`, "modelList 必须是数组")
    for (const modelNameValue of asArray(task.modelList)) {
      const modelName = String(modelNameValue)
      if (!modelNames.has(modelName)) add(issues, "error", `modelTasks.${taskName}.modelList`, `任务 ${taskName} 引用了不存在的模型：${modelName}`)
      const model = asArray(config.models).map(section).find(item => String(item.name || "") === modelName)
      if (section(model?.capabilities).chat === false) add(issues, "error", `modelTasks.${taskName}.modelList`, `聊天任务不能使用 embedding-only 模型：${modelName}`)
    }
    const selectionStrategy = String(task.selectionStrategy || "")
    if (selectionStrategy && !selectionStrategies.has(selectionStrategy)) {
      add(issues, "error", `modelTasks.${taskName}.selectionStrategy`, `未知模型选择策略：${selectionStrategy}`)
    }
    if (task.maxTokens !== undefined) positiveNumber(issues, `modelTasks.${taskName}.maxTokens`, task.maxTokens, { min: 1, max: 65536 })
  }

  const chat = section(config.chat)
  const modelTasks = section(config.modelTasks)
  const defaultTask = String(chat.defaultTask || "")
  const defaultChannel = String(chat.defaultChannel || "")
  if (defaultTask && !modelTasks[defaultTask]) {
    add(issues, "error", "chat.defaultTask", `默认任务不存在：${defaultTask}`)
  }
  if (defaultChannel && !modelNames.has(defaultChannel) && !channelIds.has(defaultChannel)) {
    add(issues, "warn", "chat.defaultChannel", `默认 channel/model 未在 models 或 channels 中声明：${defaultChannel}`)
  }
  positiveNumber(issues, "chat.modelRequestTimeoutMs", chat.modelRequestTimeoutMs, { min: 1000, max: 600000 })
  if (typeof chat.modelStream !== "boolean") add(issues, "error", "chat.modelStream", "chat.modelStream 必须是布尔值")
  const recognitionModel = String(section(config.mediaRecognition).recognitionModel || "").trim()
  if (recognitionModel && !modelNames.has(recognitionModel) && !channelIds.has(recognitionModel)) {
    add(issues, "error", "mediaRecognition.recognitionModel", `媒体识别增强模型不存在：${recognitionModel}`)
  }
  const memory = section(config.memory)
  const memoryEmbeddingModel = String(section(memory.retrieval).embeddingModel || "").trim()
  if (memoryEmbeddingModel) {
    const model = asArray(config.models).map(section).find(item => String(item.name || "") === memoryEmbeddingModel)
    if (!model) add(issues, "error", "memory.retrieval.embeddingModel", `记忆召回 embedding 模型不存在：${memoryEmbeddingModel}`)
    else if (section(model.capabilities).embedding !== true) add(issues, "error", "memory.retrieval.embeddingModel", `记忆召回模型未开启 embedding 能力：${memoryEmbeddingModel}`)
  }
  const consolidationModel = String(section(section(memory.groupCapture).consolidation).modelName || "").trim()
  if (consolidationModel) {
    const model = asArray(config.models).map(section).find(item => String(item.name || "") === consolidationModel)
    if (!model) add(issues, "error", "memory.groupCapture.consolidation.modelName", `群提炼模型不存在：${consolidationModel}`)
    else if (section(model.capabilities).chat === false) add(issues, "error", "memory.groupCapture.consolidation.modelName", `群提炼模型不支持对话：${consolidationModel}`)
  }
}

function validateChatAccess(config: ConfigRecord, issues: ValidationIssue[]): void {
  const access = config.chat?.access
  if (access === undefined) return
  if (!isObject(access)) {
    add(issues, "error", "chat.access", "chat.access 必须是对象")
    return
  }
  for (const field of ["whitelist", "blacklist"]) {
    const value = access[field]
    if (value !== undefined && !Array.isArray(value) && typeof value !== "string") {
      add(issues, "error", `chat.access.${field}`, `${field} 必须是数组或逗号分隔字符串`)
    }
  }
}

function validateTools(config: ConfigRecord, issues: ValidationIssue[]): void {
  requireObject(issues, config, "tools", config.tools)
  if (config.tools?.enabledTools !== undefined) requireArray(issues, "tools.enabledTools", config.tools.enabledTools)
  if (config.tools?.activePresets !== undefined) requireArray(issues, "tools.activePresets", config.tools.activePresets)
  if (config.tools?.runtimeVariables !== undefined && !isObject(config.tools.runtimeVariables)) add(issues, "error", "tools.runtimeVariables", "runtimeVariables 必须是对象")
  const websiteFetch = config.tools?.builtin?.websiteFetch
  if (websiteFetch !== undefined) {
    if (!isObject(websiteFetch)) add(issues, "error", "tools.builtin.websiteFetch", "websiteFetch 必须是对象")
    else {
      positiveNumber(issues, "tools.builtin.websiteFetch.maxChars", websiteFetch.maxChars, { min: 500, max: 20000 })
      positiveNumber(issues, "tools.builtin.websiteFetch.maxBytes", websiteFetch.maxBytes, { min: 16384, max: 10485760 })
      positiveNumber(issues, "tools.builtin.websiteFetch.maxUrlLength", websiteFetch.maxUrlLength, { min: 32, max: 8192 })
      positiveNumber(issues, "tools.builtin.websiteFetch.timeoutMs", websiteFetch.timeoutMs, { min: 1000, max: 120000 })
    }
  }
  const imageSearch = config.tools?.builtin?.imageSearch
  if (imageSearch !== undefined) {
    if (!isObject(imageSearch)) add(issues, "error", "tools.builtin.imageSearch", "imageSearch 必须是对象")
    else {
      const defaultSource = String(imageSearch.defaultSource || "")
      const imageSources = ["bing", "baidu", "serp-bing", "serp-yandex", "pixiv"]
      if (defaultSource && !imageSources.includes(defaultSource)) {
        add(issues, "error", "tools.builtin.imageSearch.defaultSource", `图片搜索来源必须是 ${imageSources.join(" / ")}`)
      }
      if (imageSearch.enabledSources !== undefined) {
        if (!Array.isArray(imageSearch.enabledSources)) add(issues, "error", "tools.builtin.imageSearch.enabledSources", "图片搜索启用渠道必须是数组")
        else if (imageSearch.enabledSources.some(source => !imageSources.includes(String(source)))) add(issues, "error", "tools.builtin.imageSearch.enabledSources", "图片搜索启用渠道包含未知来源")
      }
      positiveNumber(issues, "tools.builtin.imageSearch.maxResults", imageSearch.maxResults, { min: 1, max: 10 })
      positiveNumber(issues, "tools.builtin.imageSearch.timeoutMs", imageSearch.timeoutMs, { min: 1000, max: 60000 })
      if (imageSearch.cacheSelectedImages !== undefined && typeof imageSearch.cacheSelectedImages !== "boolean") add(issues, "error", "tools.builtin.imageSearch.cacheSelectedImages", "cacheSelectedImages 必须是布尔值")
      positiveNumber(issues, "tools.builtin.imageSearch.downloadTimeoutMs", imageSearch.downloadTimeoutMs, { min: 1000, max: 120000 })
      positiveNumber(issues, "tools.builtin.imageSearch.maxImageBytes", imageSearch.maxImageBytes, { min: 1048576, max: 134217728 })
      if (imageSearch.fallbackEnabled !== undefined) add(issues, "error", "tools.builtin.imageSearch.fallbackEnabled", "fallbackEnabled 已移除，请使用 strategy")
      if (imageSearch.strategy !== undefined && !modelWebSearchStrategies.has(String(imageSearch.strategy))) add(issues, "error", "tools.builtin.imageSearch.strategy", "图片搜索 strategy 必须是 preferred / fallback / parallel")
      if (imageSearch.pixivR18 !== undefined && typeof imageSearch.pixivR18 !== "boolean") add(issues, "error", "tools.builtin.imageSearch.pixivR18", "pixivR18 必须是布尔值")
      if (imageSearch.pixivEndpoint !== undefined && !/^https:\/\//i.test(String(imageSearch.pixivEndpoint))) add(issues, "error", "tools.builtin.imageSearch.pixivEndpoint", "Pixiv API 地址必须使用 HTTPS")
    }
  }
  const webSearch = config.tools?.builtin?.webSearch
  if (webSearch !== undefined) {
    if (!isObject(webSearch)) add(issues, "error", "tools.builtin.webSearch", "webSearch 必须是对象")
    else {
      const webSources = ["baidu-ai", "tavily"]
      const defaultSource = String(webSearch.defaultSource || "")
      if (defaultSource && !webSources.includes(defaultSource)) add(issues, "error", "tools.builtin.webSearch.defaultSource", "网络搜索来源必须是 baidu-ai / tavily")
      if (webSearch.enabledSources !== undefined) {
        if (!Array.isArray(webSearch.enabledSources)) add(issues, "error", "tools.builtin.webSearch.enabledSources", "网络搜索启用渠道必须是数组")
        else if (webSearch.enabledSources.some(source => !webSources.includes(String(source)))) add(issues, "error", "tools.builtin.webSearch.enabledSources", "网络搜索启用渠道包含未知来源")
      }
      positiveNumber(issues, "tools.builtin.webSearch.maxResults", webSearch.maxResults, { min: 1, max: 20 })
      positiveNumber(issues, "tools.builtin.webSearch.timeoutMs", webSearch.timeoutMs, { min: 1000, max: 120000 })
      if (webSearch.fallbackEnabled !== undefined) add(issues, "error", "tools.builtin.webSearch.fallbackEnabled", "fallbackEnabled 已移除，请使用 strategy")
      if (webSearch.strategy !== undefined && !modelWebSearchStrategies.has(String(webSearch.strategy))) add(issues, "error", "tools.builtin.webSearch.strategy", "网络搜索 strategy 必须是 preferred / fallback / parallel")
    }
  }
  const toolSearch = config.tools?.builtin?.toolSearch
  if (toolSearch !== undefined) {
    if (!isObject(toolSearch)) add(issues, "error", "tools.builtin.toolSearch", "toolSearch 必须是对象")
    else if (toolSearch.localEnabled !== undefined && typeof toolSearch.localEnabled !== "boolean") add(issues, "error", "tools.builtin.toolSearch.localEnabled", "localEnabled 必须是布尔值")
  }
  const scheduleTask = config.tools?.builtin?.scheduleTask
  if (scheduleTask !== undefined) {
    if (!isObject(scheduleTask)) add(issues, "error", "tools.builtin.scheduleTask", "scheduleTask 必须是对象")
    else {
      positiveNumber(issues, "tools.builtin.scheduleTask.maxPerUser", scheduleTask.maxPerUser, { min: 1, max: 20 })
      positiveNumber(issues, "tools.builtin.scheduleTask.cronMaxPerUser", scheduleTask.cronMaxPerUser, { min: 1, max: 20 })
      positiveNumber(issues, "tools.builtin.scheduleTask.maxDelayMinutes", scheduleTask.maxDelayMinutes, { min: 1, max: 43200 })
      positiveNumber(issues, "tools.builtin.scheduleTask.cronMinIntervalMinutes", scheduleTask.cronMinIntervalMinutes, { min: 1, max: 1440 })
      positiveNumber(issues, "tools.builtin.scheduleTask.tickMs", scheduleTask.tickMs, { min: 10000, max: 300000 })
    }
  }
  const blockUser = config.tools?.builtin?.blockUser
  if (blockUser !== undefined) {
    if (!isObject(blockUser)) add(issues, "error", "tools.builtin.blockUser", "blockUser 必须是对象")
    else {
      positiveNumber(issues, "tools.builtin.blockUser.defaultMinutes", blockUser.defaultMinutes, { min: 1, max: 10080 })
      positiveNumber(issues, "tools.builtin.blockUser.maxMinutes", blockUser.maxMinutes, { min: 1, max: 10080 })
    }
  }
  const policy = config.tools?.policy || {}
  if (policy !== undefined && !isObject(policy)) add(issues, "error", "tools.policy", "tools.policy 必须是对象")
  const hosted = config.tools?.hosted
  if (hosted !== undefined && !isObject(hosted)) add(issues, "error", "tools.hosted", "tools.hosted 必须是对象")
  const hostedOpenAI = section(section(hosted).openai)
  if (section(hosted).openai !== undefined && !isObject(section(hosted).openai)) add(issues, "error", "tools.hosted.openai", "tools.hosted.openai 必须是对象")
  if (hostedOpenAI.enabled !== undefined && typeof hostedOpenAI.enabled !== "boolean") add(issues, "error", "tools.hosted.openai.enabled", "enabled 必须是布尔值")
  for (const key of ["webSearch", "fileSearch", "toolSearch"]) {
    const value = hostedOpenAI[key]
    if (value !== undefined && !isObject(value)) add(issues, "error", `tools.hosted.openai.${key}`, `${key} 必须是对象`)
    else if (isObject(value) && value.enabled !== undefined && typeof value.enabled !== "boolean") add(issues, "error", `tools.hosted.openai.${key}.enabled`, "enabled 必须是布尔值")
  }
  const boundaryAccess = config.tools?.boundaryAccess || {}
  if (boundaryAccess !== undefined && !isObject(boundaryAccess)) add(issues, "error", "tools.boundaryAccess", "tools.boundaryAccess 必须是对象")
  if (config.tools?.promptSelection !== undefined) {
    if (!isObject(config.tools.promptSelection)) add(issues, "error", "tools.promptSelection", "tools.promptSelection 必须是对象")
    else {
      positiveNumber(issues, "tools.promptSelection.maxTools", config.tools.promptSelection.maxTools, { min: 1, max: 64 })
      positiveNumber(issues, "tools.promptSelection.maxDefinitionTokens", config.tools.promptSelection.maxDefinitionTokens, { min: 100, max: 20000 })
    }
  }
  for (const [role, entry] of Object.entries(boundaryAccess.roles || {})) {
    if (!boundaryRoles.has(role)) add(issues, "error", `tools.boundaryAccess.roles.${role}`, `未知边界权限角色：${role}`)
    if (!isObject(entry)) {
      add(issues, "error", `tools.boundaryAccess.roles.${role}`, "角色权限配置必须是对象")
      continue
    }
    if (entry.enabledCategories !== undefined) requireArray(issues, `tools.boundaryAccess.roles.${role}.enabledCategories`, entry.enabledCategories)
    if (entry.allowedSources !== undefined) requireArray(issues, `tools.boundaryAccess.roles.${role}.allowedSources`, entry.allowedSources)
    if (entry.allowedTools !== undefined) requireArray(issues, `tools.boundaryAccess.roles.${role}.allowedTools`, entry.allowedTools)
    if (entry.deniedTools !== undefined) requireArray(issues, `tools.boundaryAccess.roles.${role}.deniedTools`, entry.deniedTools)
  }
  for (const [bucket, entries] of Object.entries({
    customPackages: boundaryAccess.customPackages,
    skillPackages: boundaryAccess.skillPackages,
    mcpServers: boundaryAccess.mcpServers,
  })) {
    if (entries === undefined) continue
    if (!isObject(entries)) {
      add(issues, "error", `tools.boundaryAccess.${bucket}`, `${bucket} 必须是对象`)
      continue
    }
    for (const [id, entry] of Object.entries(entries)) {
      if (!isObject(entry)) {
        add(issues, "error", `tools.boundaryAccess.${bucket}.${id}`, "扩展权限项必须是对象")
        continue
      }
      if (entry.minRole && !boundaryRoles.has(String(entry.minRole))) {
        add(issues, "error", `tools.boundaryAccess.${bucket}.${id}.minRole`, `未知最小角色：${entry.minRole}`)
      }
    }
  }
}

function validateMcp(config: ConfigRecord, issues: ValidationIssue[]): void {
  requireObject(issues, config, "mcp", config.mcp)
  if (!isObject(config.mcp?.servers)) add(issues, "error", "mcp.servers", "mcp.servers 必须是对象")
  for (const [serverName, server] of Object.entries(config.mcp?.servers || {})) {
    if (!isObject(server)) {
      add(issues, "error", `mcp.servers.${serverName}`, "MCP server 必须是对象")
      continue
    }
    const configuredTransport = String(server.transport || server.type || "")
    if (configuredTransport && !["stdio", "sse", "streamableHttp"].includes(configuredTransport)) {
      add(issues, "error", `mcp.servers.${serverName}.transport`, `未知 MCP 传输方式：${configuredTransport}`)
    }
    const transport = configuredTransport || (server.url ? "sse" : "stdio")
    if (server.enabled !== false && transport === "stdio" && !server.command) {
      add(issues, "error", `mcp.servers.${serverName}`, "stdio MCP server 必须配置 command")
    } else if (server.enabled !== false && transport !== "stdio" && !server.url) {
      add(issues, "error", `mcp.servers.${serverName}`, "HTTP MCP server 必须配置 url")
    }
    if (server.risk && !isToolRiskLevel(server.risk)) {
      add(issues, "error", `mcp.servers.${serverName}.risk`, `未知风险等级：${server.risk}`)
    }
    if (server.delivery && !isToolDeliveryMode(server.delivery)) {
      add(issues, "error", `mcp.servers.${serverName}.delivery`, `未知工具投递方式：${server.delivery}`)
    }
    if (server.requiresFinalReply !== undefined && typeof server.requiresFinalReply !== "boolean") {
      add(issues, "error", `mcp.servers.${serverName}.requiresFinalReply`, "requiresFinalReply 必须是布尔值")
    }
    validateToolExecutionPolicy(issues, `mcp.servers.${serverName}`, server)
    if (server.tags !== undefined && !Array.isArray(server.tags)) add(issues, "error", `mcp.servers.${serverName}.tags`, "tags 必须是数组")
    if (server.policy !== undefined && !isObject(server.policy)) add(issues, "error", `mcp.servers.${serverName}.policy`, "policy 必须是对象")
    if (server.toolPolicies !== undefined && !isObject(server.toolPolicies)) {
      add(issues, "error", `mcp.servers.${serverName}.toolPolicies`, "toolPolicies 必须是对象")
    } else {
      for (const [toolName, policy] of Object.entries(server.toolPolicies || {})) {
        if (!isObject(policy)) continue
        if (policy.risk && !isToolRiskLevel(policy.risk)) {
          add(issues, "error", `mcp.servers.${serverName}.toolPolicies.${toolName}.risk`, `未知风险等级：${policy.risk}`)
        }
        if (policy.delivery && !isToolDeliveryMode(policy.delivery)) {
          add(issues, "error", `mcp.servers.${serverName}.toolPolicies.${toolName}.delivery`, `未知工具投递方式：${policy.delivery}`)
        }
        if (policy.requiresFinalReply !== undefined && typeof policy.requiresFinalReply !== "boolean") {
          add(issues, "error", `mcp.servers.${serverName}.toolPolicies.${toolName}.requiresFinalReply`, "requiresFinalReply 必须是布尔值")
        }
        validateToolExecutionPolicy(issues, `mcp.servers.${serverName}.toolPolicies.${toolName}`, policy)
      }
    }
  }
}

function validateSubAgent(config: ConfigRecord, issues: ValidationIssue[]): void {
  const sub = config.subAgent
  if (sub === undefined) return
  if (!isObject(sub)) {
    add(issues, "error", "subAgent", "subAgent 必须是对象")
    return
  }
  positiveNumber(issues, "subAgent.maxDepth", sub.maxDepth, { min: 1, max: 5 })
  positiveNumber(issues, "subAgent.maxTasksPerDispatch", sub.maxTasksPerDispatch, { min: 1, max: 8 })
  positiveNumber(issues, "subAgent.maxToolRounds", sub.maxToolRounds, { min: 0, max: 12 })
  positiveNumber(issues, "subAgent.maxToolCallsPerRound", sub.maxToolCallsPerRound, { min: 1, max: 8 })
  positiveNumber(issues, "subAgent.maxConcurrency", sub.maxConcurrency, { min: 1, max: 8 })
  positiveNumber(issues, "subAgent.maxDurationMs", sub.maxDurationMs, { min: 10000, max: 600000 })
  const taskName = String(sub.task || "")
  const modelTasks = section(config.modelTasks)
  if (taskName && !modelTasks[taskName]) {
    add(issues, "error", "subAgent.task", `子代理任务不存在：${taskName}`)
  }
  if (sub.allowedTools !== undefined) requireArray(issues, "subAgent.allowedTools", sub.allowedTools)
}

function validateRuntimeNumbers(config: ConfigRecord, issues: ValidationIssue[]): void {
  positiveNumber(issues, "chat.maxHistoryMessages", config.chat?.maxHistoryMessages, { min: 2 })
  positiveNumber(issues, "chat.conversationTtlMs", config.chat?.conversationTtlMs, { min: 60000 })
  positiveNumber(issues, "chat.maxConversationScopes", config.chat?.maxConversationScopes, { min: 10 })
  positiveNumber(issues, "chat.maxToolRounds", config.chat?.maxToolRounds, { min: 0 })
  if (config.chat?.execution !== undefined) {
    if (!isObject(config.chat.execution)) add(issues, "error", "chat.execution", "chat.execution 必须是对象")
    else {
      positiveNumber(issues, "chat.execution.maxToolCalls", config.chat.execution.maxToolCalls, { min: 1, max: 1000, integer: true })
      positiveNumber(issues, "chat.execution.maxSideEffectCalls", config.chat.execution.maxSideEffectCalls, { min: 1, max: 1000, integer: true })
      positiveNumber(issues, "chat.execution.maxConsecutiveGuardBlocks", config.chat.execution.maxConsecutiveGuardBlocks, { min: 1, max: 20, integer: true })
      positiveNumber(issues, "chat.execution.maxNoProgress", config.chat.execution.maxNoProgress, { min: 1, max: 20, integer: true })
      positiveNumber(issues, "chat.execution.defaultMaxAttempts", config.chat.execution.defaultMaxAttempts, { min: 1, max: 5, integer: true })
      positiveNumber(issues, "chat.execution.toolTimeoutMs", config.chat.execution.toolTimeoutMs, { min: 1000, max: 600000, integer: true })
      if (config.chat.execution.background !== undefined) {
        if (!isObject(config.chat.execution.background)) add(issues, "error", "chat.execution.background", "chat.execution.background 必须是对象")
        else {
          if (config.chat.execution.background.enabled !== undefined && typeof config.chat.execution.background.enabled !== "boolean") add(issues, "error", "chat.execution.background.enabled", "chat.execution.background.enabled 必须是布尔值")
          positiveNumber(issues, "chat.execution.background.maxConcurrent", config.chat.execution.background.maxConcurrent, { min: 1, max: 32, integer: true })
          positiveNumber(issues, "chat.execution.background.maxQueue", config.chat.execution.background.maxQueue, { min: 1, max: 1000, integer: true })
          positiveNumber(issues, "chat.execution.background.retentionMs", config.chat.execution.background.retentionMs, { min: 60000, max: 7 * 86400000, integer: true })
        }
      }
    }
  }
  positiveNumber(issues, "chat.inputTokenBudget", config.chat?.inputTokenBudget, { min: 1000, max: 1000000 })
  if (config.storage?.sqlite !== undefined) {
    if (!isObject(config.storage.sqlite)) add(issues, "error", "storage.sqlite", "storage.sqlite 必须是对象")
    else {
      positiveNumber(issues, "storage.sqlite.busyTimeoutMs", config.storage.sqlite.busyTimeoutMs, { min: 100, max: 600000 })
      if (config.storage.sqlite.synchronous && !["FULL", "NORMAL"].includes(String(config.storage.sqlite.synchronous).toUpperCase())) add(issues, "error", "storage.sqlite.synchronous", "synchronous 只支持 FULL 或 NORMAL")
    }
  }
  positiveNumber(issues, "response.autoUsePictureThreshold", config.response?.autoUsePictureThreshold, { min: 100, level: "warn" })
  const segmentation = config.response?.segmentation
  if (segmentation !== undefined) {
    if (!isObject(segmentation)) add(issues, "error", "response.segmentation", "response.segmentation 必须是对象")
    else {
      if (segmentation.enabled !== undefined && typeof segmentation.enabled !== "boolean") {
        add(issues, "error", "response.segmentation.enabled", "enabled 必须是布尔值")
      }
      if (segmentation.intervalMethod && !segmentationIntervalMethods.has(String(segmentation.intervalMethod))) {
        add(issues, "error", "response.segmentation.intervalMethod", "intervalMethod 只支持 random 或 log")
      }
      if (segmentation.mode && !segmentationModes.has(String(segmentation.mode))) {
        add(issues, "error", "response.segmentation.mode", "mode 只支持 regex 或 natural")
      }
      positiveNumber(issues, "response.segmentation.intervalMinSeconds", segmentation.intervalMinSeconds, { min: 0, max: 3600 })
      positiveNumber(issues, "response.segmentation.intervalMaxSeconds", segmentation.intervalMaxSeconds, { min: 0, max: 3600 })
      positiveNumber(issues, "response.segmentation.thresholdChars", segmentation.thresholdChars, { min: 1, max: 100000, integer: true })
      if (Number(segmentation.intervalMinSeconds) > Number(segmentation.intervalMaxSeconds)) {
        add(issues, "error", "response.segmentation.intervalMaxSeconds", "intervalMaxSeconds 不能小于 intervalMinSeconds")
      }
      const regexValues: Array<[string, unknown]> = [
        ["response.segmentation.regex", segmentation.regex],
        ["response.segmentation.contentFilterRegex", segmentation.contentFilterRegex],
      ]
      for (const [path, value] of regexValues) {
        if (value !== undefined && String(value).length > 1000) add(issues, "error", path, `${path} 最多 1000 个字符`)
        if (value) {
          try {
            new RegExp(String(value), "gmsu")
          } catch {
            add(issues, "error", path, `${path} 不是有效的正则表达式`)
          }
        }
      }
    }
  }
  const filtering = config.response?.messageFilters
  if (filtering !== undefined) {
    if (!isObject(filtering)) add(issues, "error", "response.messageFilters", "messageFilters 必须是对象")
    else {
      if (filtering.runtimeVariables !== undefined && !isObject(filtering.runtimeVariables)) {
        add(issues, "error", "response.messageFilters.runtimeVariables", "runtimeVariables 必须是对象")
      }
      if (filtering.filters !== undefined && !Array.isArray(filtering.filters)) add(issues, "error", "response.messageFilters.filters", "filters 必须是数组")
      else if (Array.isArray(filtering.filters)) {
        if (filtering.filters.length > 30) add(issues, "error", "response.messageFilters.filters", "消息过滤器最多 30 个")
        const ids = new Set<string>()
        for (const [index, filter] of filtering.filters.entries()) {
          const path = `response.messageFilters.filters.${index}`
          if (!isObject(filter)) { add(issues, "error", path, "过滤器必须是对象"); continue }
          const id = String(filter.id || "").trim()
          const stage = String(filter.stage || "")
          const priority = Number(filter.priority)
          if (!id) add(issues, "error", `${path}.id`, "过滤器 ID 不能为空")
          else if (ids.has(id)) add(issues, "error", `${path}.id`, "过滤器 ID 不能重复")
          else ids.add(id)
          if (!["input", "output"].includes(stage)) add(issues, "error", `${path}.stage`, "stage 只支持 input（模型前）或 output（回复后）")
          if (!Number.isInteger(priority) || priority < -10000 || priority > 10000) {
            add(issues, "error", `${path}.priority`, "priority 必须是 -10000 到 10000 之间的整数")
          }
          if (!isObject(filter.implementation)) add(issues, "error", `${path}.implementation`, "过滤器必须声明 implementation")
          else {
            if (filter.implementation.type !== "filter") add(issues, "error", `${path}.implementation.type`, "implementation.type 只支持 filter")
            if (!String(filter.implementation.id || "").trim()) add(issues, "error", `${path}.implementation.id`, "过滤器必须引用一个实现")
            if (filter.implementation.arguments !== undefined && !isObject(filter.implementation.arguments)) add(issues, "error", `${path}.implementation.arguments`, "过滤器实现参数必须是对象")
          }
          if (filter.condition?.minTextLength !== undefined) positiveNumber(issues, `${path}.condition.minTextLength`, filter.condition.minTextLength, { min: 0, max: 20000 })
        }
      }
    }
  }
  const response = section(config.response)
  const render = section(response.render)
  if (response.render !== undefined && !isObject(response.render)) add(issues, "error", "response.render", "response.render 必须是对象")
  const renderEngine = String(render.engine || "")
  if (renderEngine && !renderEngines.has(renderEngine)) {
    add(issues, "error", "response.render.engine", `未知渲染引擎：${renderEngine}`)
  }
  const systemRender = render.system
  if (systemRender !== undefined) {
    if (!isObject(systemRender)) add(issues, "error", "response.render.system", "系统渲染策略必须是对象")
    else {
      const systemEngine = String(systemRender.engine || "")
      if (systemEngine && !renderEngines.has(systemEngine)) add(issues, "error", "response.render.system.engine", `未知系统渲染引擎：${systemEngine}`)
    }
  }
  positiveNumber(issues, "response.render.width", render.width, { min: 720, max: 1800 })
  positiveNumber(issues, "response.render.maxTextChars", render.maxTextChars, { min: 200 })
  positiveNumber(issues, "response.render.mediaThumbnailMaxCount", render.mediaThumbnailMaxCount, { min: 0, max: 6 })
  positiveNumber(issues, "response.render.mediaThumbnailMaxDataUrlChars", render.mediaThumbnailMaxDataUrlChars, { min: 1000, max: 4000000 })
  const mediaThumbnail = render.mediaThumbnail
  if (mediaThumbnail !== undefined) {
    if (!isObject(mediaThumbnail)) add(issues, "error", "response.render.mediaThumbnail", "response.render.mediaThumbnail 必须是对象")
    else {
      positiveNumber(issues, "response.render.mediaThumbnail.maxWidth", mediaThumbnail.maxWidth, { min: 80, max: 1200 })
      positiveNumber(issues, "response.render.mediaThumbnail.maxHeight", mediaThumbnail.maxHeight, { min: 80, max: 1200 })
      positiveNumber(issues, "response.render.mediaThumbnail.quality", mediaThumbnail.quality, { min: 40, max: 95 })
      positiveNumber(issues, "response.render.mediaThumbnail.maxSourceBytes", mediaThumbnail.maxSourceBytes, { min: 1024, max: 20000000 })
      const format = String(mediaThumbnail.format || "")
      if (format && !new Set(["jpeg", "webp"]).has(format)) {
        add(issues, "error", "response.render.mediaThumbnail.format", `未知缩略图格式：${format}`)
      }
    }
  }
  const renderDelivery = render.delivery
  if (renderDelivery !== undefined && !isObject(renderDelivery)) {
    add(issues, "error", "response.render.delivery", "response.render.delivery 必须是对象")
  }
  const renderHtml = render.html
  if (renderHtml !== undefined) {
    if (!isObject(renderHtml)) add(issues, "error", "response.render.html", "response.render.html 必须是对象")
    else {
      positiveNumber(issues, "response.render.html.maxUrlLength", renderHtml.maxUrlLength, { min: 32, max: 8192 })
      positiveNumber(issues, "response.render.html.maxHtmlChars", renderHtml.maxHtmlChars, { min: 1000, max: 2000000 })
      positiveNumber(issues, "response.render.html.timeoutMs", renderHtml.timeoutMs, { min: 1000, max: 120000 })
      positiveNumber(issues, "response.render.html.waitMs", renderHtml.waitMs, { min: 0, max: 3000 })
      positiveNumber(issues, "response.render.html.deviceScaleFactor", renderHtml.deviceScaleFactor, { min: 0.5, max: 3 })
      if (renderHtml.enabled === true && !asArray(section(section(config.security).linkSafety).screenshotAllowedHosts).length) {
        add(issues, "warn", "security.linkSafety.screenshotAllowedHosts", "HTML 后端已启用，但 URL 截图没有允许域名；本地 HTML、Markdown 和思维导图渲染仍可使用")
      }
      if (renderHtml.viewport !== undefined) {
        if (!isObject(renderHtml.viewport)) add(issues, "error", "response.render.html.viewport", "viewport 必须是对象")
        else {
          positiveNumber(issues, "response.render.html.viewport.width", renderHtml.viewport.width, { min: 320, max: 2400 })
          positiveNumber(issues, "response.render.html.viewport.height", renderHtml.viewport.height, { min: 240, max: 2400 })
        }
      }
    }
  }
  positiveNumber(issues, "context.recentMessageCount", config.context?.recentMessageCount, { min: 0, max: 1000, integer: true })
  positiveNumber(issues, "memory.relevantLimit", config.memory?.relevantLimit, { min: 0 })
  positiveNumber(issues, "memory.maxFactsPerUser", config.memory?.maxFactsPerUser, { min: 1 })
  positiveNumber(issues, "memory.maxEpisodesPerScope", config.memory?.maxEpisodesPerScope, { min: 10, max: 5000 })
  positiveNumber(issues, "memory.maxMemoriesPerOwner", config.memory?.maxMemoriesPerOwner, { min: 50, max: 5000 })
  positiveNumber(issues, "memory.maxLoadedMemoriesPerOwner", config.memory?.maxLoadedMemoriesPerOwner, { min: 50, max: 5000 })
  positiveNumber(issues, "memory.cacheEntries", config.memory?.cacheEntries, { min: 16, max: 5000 })
  positiveNumber(issues, "memory.flushDelayMs", config.memory?.flushDelayMs, { min: 500, max: 300000 })
  positiveNumber(issues, "memory.promptBudgetChars", config.memory?.promptBudgetChars, { min: 300, max: 20000 })
  positiveNumber(issues, "memory.profileFactLimit", config.memory?.profileFactLimit, { min: 0 })
  const numericRanges: Array<[string, unknown, number, number]> = [
    ["memory.retention.shortTermHours", config.memory?.retention?.shortTermHours, 1, 8760],
    ["memory.retention.episodeDays", config.memory?.retention?.episodeDays, 1, 3650],
    ["memory.retention.expiredGraceDays", config.memory?.retention?.expiredGraceDays, 0, 3650],
    ["memory.retrieval.resultLimit", config.memory?.retrieval?.resultLimit, 1, 20],
    ["memory.retrieval.promptTokenBudget", config.memory?.retrieval?.promptTokenBudget, 0, 10000],
    ["memory.retrieval.embeddingTokensPerDay", config.memory?.retrieval?.embeddingTokensPerDay, 0, 100000000],
    ["memory.retrieval.ftsCandidateLimit", config.memory?.retrieval?.ftsCandidateLimit, 1, 1000],
    ["memory.retrieval.vectorCandidateLimit", config.memory?.retrieval?.vectorCandidateLimit, 0, 1000],
    ["memory.retrieval.embeddingDimensions", config.memory?.retrieval?.embeddingDimensions, 0, 8192],
    ["memory.groupCapture.consolidation.minConfidence", config.memory?.groupCapture?.consolidation?.minConfidence, 0, 1],
    ["memory.groupCapture.consolidation.maxWindowsPerScan", config.memory?.groupCapture?.consolidation?.maxWindowsPerScan, 1, 64],
    ["memory.groupCapture.defaultRetentionDays", config.memory?.groupCapture?.defaultRetentionDays, 0, 100000000],
    ["memory.groupCapture.defaultTokenLimit", config.memory?.groupCapture?.defaultTokenLimit, 3000, 60000],
    ["memory.groupCapture.flushDelayMs", config.memory?.groupCapture?.flushDelayMs, 100, 300000],
    ["memory.groupCapture.maxPendingMessages", config.memory?.groupCapture?.maxPendingMessages, 100, 50000],
    ["memory.groupCapture.maxSegmentsPerMessage", config.memory?.groupCapture?.maxSegmentsPerMessage, 1, 1000],
    ["memory.groupCapture.maxTextChars", config.memory?.groupCapture?.maxTextChars, 100, 100000],
    ["memory.groupCapture.historyBackfillMaxMessages", config.memory?.groupCapture?.historyBackfillMaxMessages, 1, 5000],
    ["memory.groupCapture.windowCloseDelayMinutes", config.memory?.groupCapture?.windowCloseDelayMinutes, 1, 1440],
    ["memory.groupCapture.scanIntervalMs", config.memory?.groupCapture?.scanIntervalMs, 10000, 3600000],
    ["memory.groupCapture.consolidation.maxAttempts", config.memory?.groupCapture?.consolidation?.maxAttempts, 1, 20],
    ["memory.groupCapture.consolidation.maxTokens", config.memory?.groupCapture?.consolidation?.maxTokens, 256, 65536],
    ["knowledge.indexing.maxFileBytes", config.knowledge?.indexing?.maxFileBytes, 1024, 1073741824],
    ["knowledge.indexing.maxChunksPerKnowledgeBase", config.knowledge?.indexing?.maxChunksPerKnowledgeBase, 1, 10000000],
    ["knowledge.indexing.globalEmbeddingTokensPerDay", config.knowledge?.indexing?.globalEmbeddingTokensPerDay, 0, 100000000],
    ["knowledge.indexing.batchSize", config.knowledge?.indexing?.batchSize, 1, 512],
    ["knowledge.indexing.concurrency", config.knowledge?.indexing?.concurrency, 1, 16],
    ["knowledge.indexing.maxAttempts", config.knowledge?.indexing?.maxAttempts, 1, 20],
    ["knowledge.retrieval.ftsCandidateLimit", config.knowledge?.retrieval?.ftsCandidateLimit, 1, 1000],
    ["knowledge.retrieval.vectorCandidateLimit", config.knowledge?.retrieval?.vectorCandidateLimit, 0, 1000],
    ["knowledge.retrieval.resultLimit", config.knowledge?.retrieval?.resultLimit, 1, 20],
    ["knowledge.retrieval.resultTokenBudget", config.knowledge?.retrieval?.resultTokenBudget, 0, 20000],
    ["knowledge.retrieval.rerankCallsPerConversation", config.knowledge?.retrieval?.rerankCallsPerConversation, 0, 100],
    ["knowledge.retrieval.rerankCallsPerDay", config.knowledge?.retrieval?.rerankCallsPerDay, 0, 100000],
    ["knowledge.commandRetrieval.vectorCandidateLimit", config.knowledge?.commandRetrieval?.vectorCandidateLimit, 0, 1000],
    ["knowledge.commandRetrieval.lexicalWeight", config.knowledge?.commandRetrieval?.lexicalWeight, 0, 10],
    ["knowledge.commandRetrieval.vectorWeight", config.knowledge?.commandRetrieval?.vectorWeight, 0, 10],
  ]
  for (const [path, value, min, max] of numericRanges) positiveNumber(issues, path, value, { min, max })
  if (config.memory?.groupCapture?.enabled !== undefined && typeof config.memory.groupCapture.enabled !== "boolean") {
    add(issues, "error", "memory.groupCapture.enabled", "groupCapture.enabled 必须是布尔值")
  }
  if (config.memory?.groupCapture?.consolidation?.enabled !== undefined && typeof config.memory.groupCapture.consolidation.enabled !== "boolean") {
    add(issues, "error", "memory.groupCapture.consolidation.enabled", "consolidation.enabled 必须是布尔值")
  }
  const consolidationSchedule = config.memory?.groupCapture?.consolidation?.schedule
  if (consolidationSchedule !== undefined) {
    const schedule = section(consolidationSchedule)
    const mode = String(schedule.mode || "interval").trim().toLowerCase()
    if (!new Set(["interval", "time", "cron"]).has(mode)) {
      add(issues, "error", "memory.groupCapture.consolidation.schedule.mode", "调度模式只能是 interval、time 或 cron")
    }
    const time = String(schedule.time || "03:00").trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      add(issues, "error", "memory.groupCapture.consolidation.schedule.time", "固定时间必须是 00:00–23:59 的 HH:mm 格式")
    }
    const cron = String(schedule.cron || "").trim()
    if (cron || mode === "cron") {
      try { parseCronExpression(cron) } catch (error) {
        add(issues, "error", "memory.groupCapture.consolidation.schedule.cron", String((error as UnknownRecord)?.message || error))
      }
    }
  }
  const commandRetrievalMode = String(config.knowledge?.commandRetrieval?.mode || "hybrid").trim().toLowerCase()
  if (!new Set(["lexical", "hybrid"]).has(commandRetrievalMode)) {
    add(issues, "error", "knowledge.commandRetrieval.mode", "指令检索策略只能是 lexical 或 hybrid")
  }
  positiveNumber(issues, "knowledge.maxEvents", config.knowledge?.maxEvents, { min: 10 })
  positiveNumber(issues, "knowledge.flushDelayMs", config.knowledge?.flushDelayMs, { min: 100 })
  if (config.logging?.level !== undefined && !isLogLevel(config.logging.level)) {
    add(issues, "error", "logging.level", "日志等级必须是 off、error、warn、info 或 debug")
  }
  positiveNumber(issues, "logging.history.detailRetentionDays", config.logging?.history?.detailRetentionDays, { min: 1, max: 3650, integer: true })
  positiveNumber(issues, "logging.history.aggregateRetentionDays", config.logging?.history?.aggregateRetentionDays, { min: 1, max: 3650, integer: true })
  const detailRetentionDays = Number(config.logging?.history?.detailRetentionDays || 7)
  const aggregateRetentionDays = Number(config.logging?.history?.aggregateRetentionDays || 90)
  if (aggregateRetentionDays < detailRetentionDays) add(issues, "error", "logging.history.aggregateRetentionDays", "汇总保留天数不能少于详情保留天数")
  if (config.knowledge?.commandPrefixes !== undefined) {
    if (!Array.isArray(config.knowledge.commandPrefixes)) {
      add(issues, "error", "knowledge.commandPrefixes", "knowledge.commandPrefixes 必须是数组")
    } else {
      const prefixes = config.knowledge.commandPrefixes.map(item => String(item || "").trim()).filter(Boolean)
      if (!prefixes.length) add(issues, "error", "knowledge.commandPrefixes", "至少需要一个指令前缀")
      for (const prefix of prefixes) {
        if (prefix.length > 4) add(issues, "warn", "knowledge.commandPrefixes", `指令前缀过长：${prefix}`)
      }
    }
  }
  for (const key of ["excludedPlugins", "excludedCommands"]) {
    if (config.knowledge?.[key] !== undefined && !Array.isArray(config.knowledge[key])) {
      add(issues, "error", `knowledge.${key}`, `knowledge.${key} 必须是数组`)
    }
  }
  positiveNumber(issues, "mediaRecognition.remoteFetch.maxBytes", config.mediaRecognition?.remoteFetch?.maxBytes, { min: 1024 })
  positiveNumber(issues, "mediaRecognition.remoteFetch.timeoutMs", config.mediaRecognition?.remoteFetch?.timeoutMs, { min: 100 })
  positiveNumber(issues, "mediaRecognition.remoteFetch.maxAttachments", config.mediaRecognition?.remoteFetch?.maxAttachments, { min: 0 })
  if (config.persona?.runtimePrompt !== undefined) {
    if (typeof config.persona.runtimePrompt !== "string" || !config.persona.runtimePrompt.trim()) {
      add(issues, "error", "persona.runtimePrompt", "系统运行规则必须是非空字符串")
    } else if (config.persona.runtimePrompt.length > 50000) {
      add(issues, "error", "persona.runtimePrompt", "系统运行规则不能超过 50000 个字符")
    }
  }
  if (config.persona?.trigger !== undefined && !isObject(config.persona.trigger)) add(issues, "error", "persona.trigger", "persona.trigger 必须是对象")
  if (config.persona?.trigger) {
    positiveNumber(issues, "persona.trigger.probabilityPercent", config.persona.trigger.probabilityPercent, { min: 0, max: 100 })
    positiveNumber(issues, "persona.trigger.cooldownMs", config.persona.trigger.cooldownMs, { min: 0 })
    positiveNumber(issues, "persona.trigger.groupCooldownMs", config.persona.trigger.groupCooldownMs, { min: 0 })
    positiveNumber(issues, "persona.trigger.enhanceRecallMs", config.persona.trigger.enhanceRecallMs, { min: 0, max: 120000 })
    if (config.persona.trigger.disabledGroupIds !== undefined && !Array.isArray(config.persona.trigger.disabledGroupIds)) {
      add(issues, "error", "persona.trigger.disabledGroupIds", "disabledGroupIds 必须是数组")
    }
    if (config.persona.trigger.enhanceKeywords !== undefined && !Array.isArray(config.persona.trigger.enhanceKeywords)) {
      add(issues, "error", "persona.trigger.enhanceKeywords", "enhanceKeywords 必须是数组")
    }
    if (config.persona.trigger.ambient !== undefined) {
      if (!isObject(config.persona.trigger.ambient)) add(issues, "error", "persona.trigger.ambient", "ambient 必须是对象")
      else {
        positiveNumber(issues, "persona.trigger.ambient.minMessageChars", config.persona.trigger.ambient.minMessageChars, { min: 0, max: 100 })
        positiveNumber(issues, "persona.trigger.ambient.probabilityPercent", config.persona.trigger.ambient.probabilityPercent, { min: 0, max: 100 })
      }
    }
    if (config.persona.trigger.poke !== undefined) {
      if (!isObject(config.persona.trigger.poke)) add(issues, "error", "persona.trigger.poke", "poke 必须是对象")
      else {
        positiveNumber(issues, "persona.trigger.poke.probabilityPercent", config.persona.trigger.poke.probabilityPercent, { min: 0, max: 100 })
        positiveNumber(issues, "persona.trigger.poke.cooldownMs", config.persona.trigger.poke.cooldownMs, { min: 0 })
        positiveNumber(issues, "persona.trigger.poke.groupCooldownMs", config.persona.trigger.poke.groupCooldownMs, { min: 0 })
        const responseMode = String(config.persona.trigger.poke.responseMode || "")
        if (responseMode && !pokeResponseModes.has(responseMode)) {
          add(issues, "error", "persona.trigger.poke.responseMode", `未知戳一戳回应模式：${responseMode}`)
        }
        if (config.persona.trigger.poke.fallbackMessages !== undefined && !Array.isArray(config.persona.trigger.poke.fallbackMessages)) {
          add(issues, "error", "persona.trigger.poke.fallbackMessages", "fallbackMessages 必须是数组")
        }
      }
    }
  }
  if (config.persona?.output !== undefined && !isObject(config.persona.output)) add(issues, "error", "persona.output", "persona.output 必须是对象")
  if (config.persona?.initiativeGreeting !== undefined) {
    if (!isObject(config.persona.initiativeGreeting)) add(issues, "error", "persona.initiativeGreeting", "persona.initiativeGreeting 必须是对象")
    else {
      const greeting = config.persona.initiativeGreeting
      if (greeting.groups !== undefined && !Array.isArray(greeting.groups)) {
        add(issues, "error", "persona.initiativeGreeting.groups", "groups 必须是数组")
      }
      positiveNumber(issues, "persona.initiativeGreeting.intervalHours", greeting.intervalHours, { min: 1, max: 24 })
      positiveNumber(issues, "persona.initiativeGreeting.probabilityPercent", greeting.probabilityPercent, { min: 0, max: 100 })
      positiveNumber(issues, "persona.initiativeGreeting.maxChars", greeting.maxChars, { min: 8, max: 200 })
      if (greeting.fallbackMessages !== undefined && !Array.isArray(greeting.fallbackMessages)) {
        add(issues, "error", "persona.initiativeGreeting.fallbackMessages", "fallbackMessages 必须是数组")
      }
    }
  }
}

export function validateConfig(config: unknown): ValidationResult {
  const issues: ValidationIssue[] = []
  if (!isObject(config)) {
    const issue: ValidationIssue = { level: "error", path: "config", message: "配置必须是对象" }
    return { ok: false, issues: [issue], errors: [issue], warnings: [] }
  }
  const root = config as ConfigRecord
  validateWeb(root, issues)
  validateSystem(root, issues)
  validateLinkSafety(root, issues)
  validateSkills(root, issues)
  validateChatAccess(root, issues)
  validateProviders(root, issues)
  validateTools(root, issues)
  validateMcp(root, issues)
  validateSubAgent(root, issues)
  validateRuntimeNumbers(root, issues)
  return {
    ok: !issues.some(issue => issue.level === "error"),
    issues,
    errors: issues.filter(issue => issue.level === "error"),
    warnings: issues.filter(issue => issue.level === "warn"),
  }
}

export function assertConfigValid(config: unknown): ValidationResult {
  const result = validateConfig(config)
  if (result.ok) return result
  const message = result.errors.slice(0, 8).map(issue => `${issue.path}: ${issue.message}`).join("\n")
  const err = new Error(`配置校验失败：\n${message}`)
  Object.assign(err, { validation: result })
  throw err
}
