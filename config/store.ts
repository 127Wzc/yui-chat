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
type ConfigBackend = "json" | "sqlite"
type ConfigPath = readonly string[]
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
type ReloadOptions = { force?: boolean; persistDefaults?: boolean; keepCurrent?: boolean }
type BackupOptions = { beforeSave?: (sqliteConfig: unknown) => Promise<void> | void }

const pluginRootOverride = String(process.env.YUI_CHAT_PLUGIN_ROOT || "").trim()
/** 插件源码与资源根目录；编译产物通过环境变量保持与源码相同的数据定位。 */
export const pluginRoot = pluginRootOverride
  ? path.resolve(pluginRootOverride)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const yunzaiRoot = path.resolve(pluginRoot, "../..")

const runtimeRootValue = String(process.env.YUI_CHAT_RUNTIME_ROOT || "").trim()
/** 显式隔离的测试运行根；生产未设置时保持宿主既有目录。 */
export const runtimeRoot = runtimeRootValue ? path.resolve(runtimeRootValue) : ""
export const configDir = runtimeRoot ? path.join(runtimeRoot, "config") : path.join(pluginRoot, "config")
export const configFile = path.join(configDir, "config.json")
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
  "password", "passwords", "secret", "secrets", "token", "tokens",
])
const noConfigOverride = Symbol("no-config-override")
const localConfigFormat = "yui-chat-bootstrap-v1"
const configPublishHooks = new Set<ConfigPublishHook>()
const bootstrapConfigPaths: ConfigPath[] = [
  ["web", "authToken"],
  ["storage", "sqlite", "enabled"],
  ["storage", "sqlite", "busyTimeoutMs"],
  ["storage", "sqlite", "synchronous"],
]

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

function configPathValue(value: unknown, parts: ConfigPath): { exists: boolean; value: unknown } {
  let current: unknown = value
  for (const part of parts) {
    if (!isObject(current) || !Object.hasOwn(current, part)) return { exists: false, value: undefined }
    current = current[part]
  }
  return { exists: true, value: current }
}

function setConfigPath(target: ConfigRecord, parts: ConfigPath, value: unknown): void {
  let current = target
  for (const part of parts.slice(0, -1)) current = recordProperty(current, part)
  const last = parts[parts.length - 1]
  if (last) current[last] = clone(value)
}

function deleteConfigPath(target: unknown, parts: ConfigPath, index = 0): void {
  if (!isObject(target) || !Object.hasOwn(target, parts[index])) return
  const key = parts[index]
  if (index === parts.length - 1) delete target[key]
  else {
    deleteConfigPath(target[key], parts, index + 1)
    if (isObject(target[key]) && !Object.keys(target[key]).length) delete target[key]
  }
}

function splitStoredOverrides(overrides: ConfigRecord = {}): { bootstrap: ConfigRecord; runtime: ConfigRecord } {
  const bootstrap: ConfigRecord = {}
  const runtime = clone(overrides)
  for (const parts of bootstrapConfigPaths) {
    const entry = configPathValue(overrides, parts)
    if (entry.exists) setConfigPath(bootstrap, parts, entry.value)
    deleteConfigPath(runtime, parts)
  }
  return { bootstrap, runtime }
}

/** 拆分必须保留在启动 JSON 的引导项与 SQLite 运行覆盖项。 */
export function splitConfigOverrides(config: unknown): { all: ConfigRecord; bootstrap: ConfigRecord; runtime: ConfigRecord } {
  const all = extractConfigOverrides(config)
  return { all, ...splitStoredOverrides(all) }
}

function localConfigDocument(overrides: ConfigRecord, backend: ConfigBackend): ConfigRecord {
  if (backend !== "sqlite") return clone(overrides)
  return { $format: localConfigFormat, $runtimeConfig: "sqlite", ...clone(overrides) }
}

function parseLocalConfigDocument(value: unknown): { backend: ConfigBackend; overrides: ConfigRecord } {
  if (!isObject(value) || value.$format !== localConfigFormat) return { backend: "json", overrides: isObject(value) ? value : {} }
  if (value.$runtimeConfig !== "sqlite") throw new Error(`不支持的运行配置存储：${String(value.$runtimeConfig || "unknown")}`)
  const overrides = clone(value)
  delete overrides.$format
  delete overrides.$runtimeConfig
  return { backend: "sqlite", overrides }
}

function normalizeModelRoutingDefaults(config: Config): Config {
  recordProperty(config, "chat")
  const modelTasks = recordProperty(config, "modelTasks")
  delete recordProperty(config, "chat").defaultWorkflow
  delete config.workflows
  const defaultTasks: ConfigRecord = isObject(defaults.modelTasks) ? defaults.modelTasks : {}
  if (!isObject(modelTasks.replyer)) modelTasks.replyer = clone(defaultTasks.replyer || {})
  delete modelTasks.commandHelper
  delete modelTasks.vision_caption
  const models = Array.isArray(config.models) ? config.models : []
  for (const value of models) {
    if (!isObject(value)) continue
    const capabilities = isObject(value.capabilities) ? value.capabilities : {}
    value.capabilities = { chat: capabilities.chat !== false, embedding: Boolean(capabilities.embedding) }
    if (value.embedding !== undefined && !isObject(value.embedding)) delete value.embedding
  }
  const embeddingOnly = new Set(models
    .filter(value => isObject(value) && isObject(value.capabilities) && value.capabilities.embedding && value.capabilities.chat === false)
    .map(value => isObject(value) ? String(value.name || "") : "")
    .filter(Boolean))
  const defaultReplyer = isObject(defaultTasks.replyer) ? defaultTasks.replyer : {}
  const defaultReplyerModelList = Array.isArray(defaultReplyer.modelList) ? defaultReplyer.modelList : []
  for (const [taskName, taskValue] of Object.entries(modelTasks)) {
    if (!isObject(taskValue) || !Array.isArray(taskValue.modelList)) continue
    const modelList = taskValue.modelList
    const filteredModelList = modelList.filter(name => !embeddingOnly.has(String(name)))
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
  // 链接安全授权已经统一到 security.linkSafety；旧功能级字段直接退役，不迁移旧值。
  const mediaRecognition = isObject(config.mediaRecognition) ? config.mediaRecognition : null
  if (mediaRecognition && isObject(mediaRecognition.remoteFetch)) delete mediaRecognition.remoteFetch.allowPrivateHosts
  if (response && isObject(response.render)) {
    if (isObject(response.render.delivery)) delete response.render.delivery.allowPrivateHosts
    if (isObject(response.render.html)) {
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
    const roles = isObject(boundary.roles) ? boundary.roles : {}
    for (const profileValue of Object.values(roles)) {
      if (!isObject(profileValue)) continue
      profileValue.allowedTools = [...new Set((Array.isArray(profileValue.allowedTools) ? profileValue.allowedTools : []).map(String).filter(Boolean))]
      profileValue.deniedTools = [...new Set((Array.isArray(profileValue.deniedTools) ? profileValue.deniedTools : []).map(String).filter(Boolean))]
      if (Array.isArray(profileValue.enabledCategories) && !profileValue.enabledCategories.includes("output")) profileValue.enabledCategories.push("output")
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

/** 递归脱敏公共配置；密钥只在运行时边界存在，绝不进入 Web 或日志。 */
export function redactConfigSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map(item => redactConfigSecrets(item, key))
  if (isObject(value)) {
    const out: ConfigRecord = {}
    for (const [childKey, childValue] of Object.entries(value)) out[childKey] = redactConfigSecrets(childValue, childKey)
    return out
  }
  if (typeof value === "string" && isSecretKey(key) && value) return "********"
  return value
}

function prepareConfig(value: unknown): Config {
  const raw = clone(value || {})
  const incoming = migratePersonaPrompt(normalizeMessageFilters(isObject(raw) ? raw : {}))
  const merged = clone(mergeConfig(defaults, incoming))
  const candidate = normalizeConfig(isObject(merged) ? merged : {})
  assertConfigValid(candidate as RuntimeConfigObject)
  return candidate
}

function serializeConfig(value: Config): string {
  return `${JSON.stringify(value, null, 2) ?? "null"}\n`
}

interface ConfigFileState {
  document: ConfigRecord
  userConfig: ConfigRecord
  backendHint: ConfigBackend
  exists: boolean
  mtimeMs: number
}

/** 配置 Store 的 TypeScript 实现：串行化写入、冻结快照，并区分引导 JSON 与 SQLite 覆盖项。 */
export class ConfigStore implements ConfigStoreContract {
  private config: Config = deepFreeze(clone(defaults)) as unknown as Config
  private loaded = false
  private configFileMtimeMs = 0
  private lastReloadedAt = ""
  private lastLoadError: LoadError | null = null
  private dirsReady = false
  private revision = 0
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private runtimeConfigBackendHint: ConfigBackend = "json"
  private runtimeConfigRepository: RuntimeConfigRepository | null = null
  private runtimeConfigOverrides: Config = {}
  private runtimeConfigExists = false

  private enqueueMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const pending = this.mutationQueue.then(operation, operation)
    this.mutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async ensureDirs(): Promise<void> {
    if (this.dirsReady) return
    await fs.mkdir(configDir, { recursive: true })
    await fs.mkdir(dataDir, { recursive: true })
    await fs.mkdir(configBackupDir, { recursive: true })
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.mkdir(tempDir, { recursive: true })
    this.dirsReady = true
  }

  private async statConfigFile(): Promise<{ exists: boolean; mtimeMs: number }> {
    try {
      const stat = await fs.stat(configFile)
      return { exists: true, mtimeMs: Number(stat.mtimeMs || 0) }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
      return { exists: false, mtimeMs: 0 }
    }
  }

  private async readConfigFile(): Promise<ConfigFileState> {
    const stat = await this.statConfigFile()
    let document: unknown = {}
    if (stat.exists) {
      try {
        document = JSON.parse(await fs.readFile(configFile, "utf8"))
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error
      }
    }
    const parsed = parseLocalConfigDocument(document)
    return { document: isObject(document) ? document : {}, userConfig: parsed.overrides, backendHint: parsed.backend, exists: stat.exists, mtimeMs: stat.mtimeMs }
  }

  private publish(candidate: Config, options: { mtimeMs?: number; lastLoadError?: LoadError } = {}): Config {
    this.config = deepFreeze(candidate) as unknown as Config
    this.loaded = true
    this.configFileMtimeMs = Number(options.mtimeMs || 0)
    this.lastReloadedAt = new Date().toISOString()
    this.lastLoadError = options.lastLoadError || null
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

  private async quarantineInvalidConfig(): Promise<string> {
    const stat = await this.statConfigFile()
    if (!stat.exists) return ""
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const suffix = crypto.randomBytes(4).toString("hex")
    const quarantineFile = path.join(configBackupDir, `config.invalid.${stamp}-${suffix}.json`)
    await fs.rename(configFile, quarantineFile)
    return quarantineFile
  }

  /** 管理端显式重载配置；仍沿用 Store 内部串行与失败保留当前快照策略。 */
  async reloadFromDisk(options: ReloadOptions = {}): Promise<{ reloaded: boolean; config: Config; mtimeMs: number; error?: Error; keptCurrent?: boolean; fallbackDefault?: boolean; quarantinedFile?: string }> {
    await this.ensureDirs()
    try {
      if (this.loaded && !options.force) {
        const stat = await this.statConfigFile()
        if (stat.mtimeMs === this.configFileMtimeMs) return { reloaded: false, config: clone(this.config), mtimeMs: this.configFileMtimeMs }
      }
      const source = await this.readConfigFile()
      this.runtimeConfigBackendHint = source.backendHint
      const storedOverrides = this.runtimeConfigRepository ? mergeConfig(this.runtimeConfigOverrides, source.userConfig) : source.userConfig
      const candidate = prepareConfig(storedOverrides)
      const { all, bootstrap } = splitConfigOverrides(candidate)
      const storage = isObject(candidate.storage) && isObject(candidate.storage.sqlite) ? candidate.storage.sqlite : {}
      const expectedBackend: ConfigBackend = this.runtimeConfigRepository && storage.enabled !== false ? "sqlite" : "json"
      const expectedDocument = localConfigDocument(expectedBackend === "sqlite" ? bootstrap : all, expectedBackend)
      const shouldPersist = source.backendHint === "sqlite" && !this.runtimeConfigRepository
        ? false
        : !source.exists || (options.persistDefaults === true && serializeConfig(source.document) !== serializeConfig(expectedDocument))
      const config = shouldPersist ? await this.performSave(candidate) : this.publish(candidate, { mtimeMs: source.mtimeMs })
      return { reloaded: true, config, mtimeMs: this.configFileMtimeMs }
    } catch (error) {
      const loadError: LoadError = { message: errorMessage(error), time: new Date().toISOString() }
      if (this.loaded && options.keepCurrent !== false) {
        this.lastLoadError = loadError
        hostRuntime.logger?.warn?.("[yui-chat] 配置热重载失败，继续使用内存配置", error)
        return { reloaded: false, config: clone(this.config), mtimeMs: this.configFileMtimeMs, error: error instanceof Error ? error : new Error(errorMessage(error)), keptCurrent: true }
      }
      hostRuntime.logger?.warn?.("[yui-chat] 配置读取失败，将隔离原文件并使用默认配置", error)
      let quarantinedFile = ""
      try {
        quarantinedFile = await this.quarantineInvalidConfig()
      } catch (quarantineError) {
        hostRuntime.logger?.error?.("[yui-chat] 非法配置隔离失败，保留原文件且仅在内存使用默认配置", quarantineError)
        loadError.quarantineError = errorMessage(quarantineError)
      }
      loadError.quarantinedFile = quarantinedFile
      this.lastLoadError = loadError
      const fallback = prepareConfig(defaults)
      let config: Config
      if (quarantinedFile) {
        try {
          config = await this.performSave(fallback, { lastLoadError: loadError })
        } catch (recoveryError) {
          loadError.recoveryError = errorMessage(recoveryError)
          hostRuntime.logger?.error?.("[yui-chat] 默认配置落盘失败，仅在内存中继续运行", recoveryError)
          config = this.publish(fallback, { lastLoadError: loadError })
        }
      } else {
        config = this.publish(fallback, { lastLoadError: loadError })
      }
      return { reloaded: true, config, mtimeMs: this.configFileMtimeMs, error: error instanceof Error ? error : new Error(errorMessage(error)), fallbackDefault: true, quarantinedFile }
    }
  }

  /** 从磁盘载入一次；之后调用会先检查文件是否发生变化。 */
  async load(): Promise<RuntimeConfigObject> {
    if (this.loaded) {
      await this.reloadFromDisk({ keepCurrent: true })
      return clone(this.config) as RuntimeConfigObject
    }
    await this.enqueueMutation(() => this.reloadFromDisk({ persistDefaults: true, keepCurrent: false }))
    return clone(this.config) as RuntimeConfigObject
  }

  /** 获取冻结的运行快照，调用方禁止直接修改。 */
  get(): RuntimeConfigSnapshot {
    return this.config as RuntimeConfigSnapshot
  }

  /** 获取递归脱敏后的公共配置。 */
  getPublic(): RuntimeConfigObject {
    return redactConfigSecrets(this.config) as RuntimeConfigObject
  }

  /** 校验候选配置，不会修改当前快照。 */
  validate(nextConfig: RuntimeConfigObject = this.config as RuntimeConfigObject) {
    return validateConfig(nextConfig)
  }

  /** 返回配置来源、版本和文件位置等诊断信息，不包含配置正文或凭证。 */
  meta(): ConfigStoreMeta {
    return {
      loaded: this.loaded,
      runtimeRoot,
      configFile,
      configBackupDir,
      configFileMtimeMs: this.configFileMtimeMs,
      lastReloadedAt: this.lastReloadedAt,
      lastLoadError: this.lastLoadError,
      revision: this.revision,
      runtimeConfigBackend: this.runtimeConfigBackendHint,
      runtimeConfigAttached: Boolean(this.runtimeConfigRepository),
    }
  }

  /** 接入 SQLite 运行配置仓库，并在同一串行队列中完成首次归一化保存。 */
  attachRuntimeConfigRepository(repository: RuntimeConfigRepository): Promise<RuntimeConfigSnapshot> {
    if (!repository || typeof repository.load !== "function" || typeof repository.save !== "function") throw new TypeError("runtime config repository must expose load() and save()")
    return this.enqueueMutation(async () => {
      const stored = await repository.load()
      const source = await this.readConfigFile()
      if (source.backendHint === "sqlite" && !stored?.exists) throw new Error("SQLite 主配置记录缺失，已停止加载以避免使用默认配置覆盖本地设置。")
      const previousRepository = this.runtimeConfigRepository
      const previousOverrides = this.runtimeConfigOverrides
      const previousExists = this.runtimeConfigExists
      const previousBackendHint = this.runtimeConfigBackendHint
      this.runtimeConfigRepository = repository
      this.runtimeConfigOverrides = clone(stored?.overrides || {})
      this.runtimeConfigExists = Boolean(stored?.exists)
      this.runtimeConfigBackendHint = source.backendHint
      try {
        const merged = mergeConfig(this.runtimeConfigOverrides, source.userConfig)
        return this.performSave(prepareConfig(merged)) as Promise<RuntimeConfigSnapshot>
      } catch (error) {
        this.runtimeConfigRepository = previousRepository
        this.runtimeConfigOverrides = previousOverrides
        this.runtimeConfigExists = previousExists
        this.runtimeConfigBackendHint = previousBackendHint
        throw error
      }
    })
  }

  /** 断开 SQLite 配置仓库；默认把当前完整快照转回 JSON 覆盖项。 */
  detachRuntimeConfigRepository(options: { persistFull?: boolean } = {}): Promise<RuntimeConfigSnapshot> {
    return this.enqueueMutation(async () => {
      const snapshot = clone(this.config)
      this.runtimeConfigRepository = null
      this.runtimeConfigOverrides = {}
      this.runtimeConfigExists = false
      this.runtimeConfigBackendHint = "json"
      if (options.persistFull === false) return snapshot as RuntimeConfigSnapshot
      return this.performSave(snapshot) as Promise<RuntimeConfigSnapshot>
    })
  }

  private async performSave(nextConfig: Config, options: ConfigSaveOptions = {}): Promise<Config> {
    await this.ensureDirs()
    const candidate = prepareConfig(nextConfig)
    if (!this.runtimeConfigRepository && this.runtimeConfigBackendHint === "sqlite") throw new Error("SQLite 主配置尚未连接，拒绝覆盖仅含启动项的 config.json。")
    const { all, bootstrap, runtime } = splitConfigOverrides(candidate)
    const storage = isObject(candidate.storage) && isObject(candidate.storage.sqlite) ? candidate.storage.sqlite : {}
    const backend: ConfigBackend = this.runtimeConfigRepository && storage.enabled !== false ? "sqlite" : "json"
    const contents = serializeConfig(localConfigDocument(backend === "sqlite" ? bootstrap : all, backend))
    let previousContents: string | null = null
    let previousExists = false
    try {
      previousContents = await fs.readFile(configFile, "utf8")
      previousExists = true
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    if (previousContents !== contents) await writeFileAtomic(configFile, contents)
    const runtimeConfigChanged = !this.runtimeConfigExists || !sameJsonValue(runtime, this.runtimeConfigOverrides)
    if (this.runtimeConfigRepository && runtimeConfigChanged) {
      try {
        await this.runtimeConfigRepository.save(runtime as RuntimeConfigObject)
      } catch (error) {
        if (previousExists && previousContents !== null) await writeFileAtomic(configFile, previousContents)
        else await fs.unlink(configFile).catch(unlinkError => { if (errorCode(unlinkError) !== "ENOENT") throw unlinkError })
        throw error
      }
      this.runtimeConfigOverrides = clone(runtime)
      this.runtimeConfigExists = true
    }
    this.runtimeConfigBackendHint = backend
    let mtimeMs = 0
    try {
      const stat = await fs.stat(configFile)
      mtimeMs = Number(stat.mtimeMs || 0)
    } catch {
      // best-effort：文件时间读取失败不影响已经完成的原子替换。
    }
    return this.publish(candidate, { mtimeMs, lastLoadError: options.lastLoadError as LoadError | undefined })
  }

  /** 保存完整配置；写入与 SQLite 运行覆盖项更新保持原子失败回滚。 */
  save(nextConfig: RuntimeConfigObject = this.config as RuntimeConfigObject, options: ConfigSaveOptions = {}): Promise<RuntimeConfigSnapshot> {
    const snapshot = clone(nextConfig) as Config
    return this.enqueueMutation(() => this.performSave(snapshot, options) as Promise<RuntimeConfigSnapshot>)
  }

  /** 在最新磁盘快照上串行执行更新器，防止并发 Web 请求互相覆盖。 */
  update(mutator: RuntimeConfigUpdater, options: ConfigSaveOptions = {}): Promise<RuntimeConfigSnapshot> {
    if (typeof mutator !== "function") throw new TypeError("config updater must be a function")
    return this.enqueueMutation(async () => {
      const reload = await this.reloadFromDisk(this.loaded ? { keepCurrent: true } : { persistDefaults: true, keepCurrent: false })
      if (reload.error && reload.keptCurrent) throw new Error(`磁盘配置无效，已停止更新以避免覆盖原文件：${reload.error.message}`)
      const draft = clone(this.config) as RuntimeConfigObject
      const result = await mutator(draft)
      return this.performSave((result === undefined ? draft : result) as Config, options) as Promise<RuntimeConfigSnapshot>
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
      const candidate = prepareConfig(packaged && isObject(payload) ? payload.config : payload)
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
