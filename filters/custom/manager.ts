import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createUserExtensionStorage } from "../../extensions/storage.js"
import { sanitizeIdentifier } from "../../core/shared/identifiers.js"
import { cloneJsonValue } from "../../core/shared/json-values.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { runExecutionTest } from "../../extensions/testing/execution-runtime.js"
import { applyToolRuntimeConfigUpdate, toolConfigDefaults } from "../../extensions/runtime-config.js"
import { createFrameworkResourceAccess, validateFrameworkResources } from "../../extensions/framework-resources.js"

type AnyRecord = Record<string, any>
type ValidationIssue = { level: "error" | "warn"; path: string; message: string }
export type CustomFilterValidation = {
  ok: boolean
  issues: ValidationIssue[]
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}
type FilterDefinition = AnyRecord & { id: string; apply: (input: AnyRecord, context?: AnyRecord) => unknown }
type PackageItem = AnyRecord & {
  id: string
  dir: string
  manifest?: AnyRecord
  enabled: boolean
  validation?: CustomFilterValidation
  filters: AnyRecord[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : ""
}

const customFilterStorage = createUserExtensionStorage({
  domain: "filters",
  manifestFile: "filter.json",
})
export const customFiltersDir = customFilterStorage.dir

const allowedStages = new Set(["input", "output"])
const allowedEffects = new Set(["pure", "network", "delivery"])

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sanitizeId(value: unknown): string {
  return sanitizeIdentifier(value, 64)
}

function jsonObject(value: unknown): AnyRecord {
  return isObject(value) ? cloneJsonValue(value) : {}
}

// text 是过滤链自动绑定的正文上下文；即使手写 manifest 把它列为 required，
// 直接试跑也不应要求管理员把正文重复填写进 params。
function filterParameterSchema(parameters: AnyRecord = {}): AnyRecord {
  const schema = jsonObject(parameters)
  const properties = { ...jsonObject(schema.properties) }
  delete properties.text
  return {
    ...schema,
    properties,
    required: (Array.isArray(schema.required) ? schema.required : []).map(String).filter(name => name !== "text"),
  }
}

function packageError(message: string, properties: AnyRecord = {}): Error & AnyRecord {
  const error = new Error(message)
  Object.assign(error, properties)
  return error as Error & AnyRecord
}

async function createPackageDir(dir: string, id: string): Promise<void> {
  try {
    await fs.mkdir(dir)
  } catch (err) {
    if (errorCode(err) === "EEXIST") throw new Error(`Custom 过滤器 ID “${id}” 已存在`)
    throw err
  }
}

function createValidation(issues: ValidationIssue[] = []): CustomFilterValidation {
  return {
    ok: !issues.some(issue => issue.level === "error"),
    issues,
    errors: issues.filter(issue => issue.level === "error"),
    warnings: issues.filter(issue => issue.level === "warn"),
  }
}

function addIssue(issues: ValidationIssue[], level: ValidationIssue["level"], pathName: string, message: string): void {
  issues.push({ level, path: pathName, message })
}

function validateFilterHint(issues: ValidationIssue[], hint: unknown, index: number): void {
  const pathName = `filters.${index}`
  if (!isObject(hint)) {
    addIssue(issues, "error", pathName, `${pathName} must be an object`)
    return
  }
  const id = String(hint.id || "").trim()
  if (!id) addIssue(issues, "error", `${pathName}.id`, "filter id is required")
  if (hint.displayName !== undefined && typeof hint.displayName !== "string") {
    addIssue(issues, "warn", `${pathName}.displayName`, "displayName should be a string")
  }
  if (hint.description !== undefined && typeof hint.description !== "string") {
    addIssue(issues, "warn", `${pathName}.description`, "description should be a string")
  }
  if (!Array.isArray(hint.stages) || !hint.stages.length) {
    addIssue(issues, "error", `${pathName}.stages`, "stages must contain input and/or output")
  } else if (hint.stages.some(stage => !allowedStages.has(stage))) {
    addIssue(issues, "error", `${pathName}.stages`, "stages only support input and output")
  }
  if (hint.parameters !== undefined && !isObject(hint.parameters)) {
    addIssue(issues, "error", `${pathName}.parameters`, "parameters must be an object")
  }
  if (hint.configSchema !== undefined && !isObject(hint.configSchema)) {
    addIssue(issues, "error", `${pathName}.configSchema`, "configSchema must be an object")
  }
  if (hint.effects !== undefined) {
    if (!Array.isArray(hint.effects)) addIssue(issues, "error", `${pathName}.effects`, "effects must be an array")
    else if (hint.effects.some(effect => !allowedEffects.has(effect))) {
      addIssue(issues, "error", `${pathName}.effects`, "effects only support pure / network / delivery")
    }
  }
}

export function validateCustomFilterManifest(manifest: unknown = {}): CustomFilterValidation {
  const issues: ValidationIssue[] = []
  if (!isObject(manifest)) {
    return createValidation([{ level: "error", path: "manifest", message: "custom-filter manifest must be an object" }])
  }
  if (!String(manifest.id || "").trim()) addIssue(issues, "warn", "id", "id is recommended and should match the directory name")
  if (!String(manifest.name || "").trim()) addIssue(issues, "warn", "name", "name is recommended")
  if (!String(manifest.description || "").trim()) addIssue(issues, "warn", "description", "description is recommended")
  if (manifest.tags !== undefined && !Array.isArray(manifest.tags)) addIssue(issues, "warn", "tags", "tags should be an array")
  if (manifest.configSchema !== undefined && !isObject(manifest.configSchema)) {
    addIssue(issues, "error", "configSchema", "configSchema must be an object")
  }
  issues.push(...validateFrameworkResources(manifest.frameworkResources))
  if (!Array.isArray(manifest.filters)) {
    addIssue(issues, "error", "filters", "filters must be an array")
  } else {
    const ids = new Set()
    manifest.filters.forEach((hint, index) => {
      validateFilterHint(issues, hint, index)
      const id = String(hint?.id || "").trim()
      if (!id) return
      if (ids.has(id)) addIssue(issues, "error", `filters.${index}.id`, `duplicate filter id: ${id}`)
      ids.add(id)
    })
  }
  return createValidation(issues)
}

function resourceSummaries(manifest: AnyRecord = {}): AnyRecord[] {
  return Object.entries(manifest.frameworkResources || {}).map(([alias, value]) => (
    isObject(value) ? { alias, ...value } : { alias, reference: String(value || "") }
  ))
}

function filterHintMap(manifest: AnyRecord = {}): Map<string, AnyRecord> {
  const entries: Array<[string, AnyRecord]> = (Array.isArray(manifest.filters) ? manifest.filters : [])
    .filter(isObject)
    .map(hint => [String(hint.id || "").trim(), hint] as [string, AnyRecord])
    .filter(([id]) => Boolean(id))
  return new Map(entries)
}

function normalizeStages(value: unknown): string[] {
  const stages = Array.isArray(value) ? value.map(String).filter(stage => allowedStages.has(stage)) : []
  return [...new Set(stages)]
}

function normalizeEffects(value: unknown): string[] {
  const effects = Array.isArray(value) ? value.map(String).filter(effect => allowedEffects.has(effect)) : []
  return [...new Set(effects.length ? effects : ["pure"])]
}

function normalizeFilterDefinition(definition: unknown, hint: AnyRecord | undefined, item: PackageItem): FilterDefinition {
  if (!isObject(definition)) throw new Error(`Custom 过滤器包 ${item.id} 导出了无效的过滤器定义`)
  const id = String(definition.id || "").trim()
  if (!id) throw new Error(`Custom 过滤器包 ${item.id} 的代码实现缺少 id`)
  if (!hint) throw new Error(`Custom 过滤器 ${id} 未在 filter.json 的 filters[] 中声明`)
  if (typeof definition.apply !== "function") throw new Error(`Custom 过滤器 ${id} 缺少 apply({ text, params }, context)`)
  const stages = normalizeStages(definition.stages || hint.stages)
  if (!stages.length) throw new Error(`Custom 过滤器 ${id} 未声明可用阶段`)
  return {
    ...definition,
    id,
    displayName: definition.displayName || definition.displayNameZh || hint.displayName || hint.displayNameZh || item.manifest?.displayName || item.manifest?.name || id,
    displayNameZh: definition.displayNameZh || hint.displayNameZh || item.manifest?.displayNameZh || "",
    description: definition.description || hint.description || item.manifest?.description || "",
    descriptionZh: definition.descriptionZh || hint.descriptionZh || item.manifest?.descriptionZh || "",
    source: "custom",
    packageId: item.id,
    packageName: item.manifest?.name || item.id,
    tags: [...new Set([...(item.manifest?.tags || []), ...(hint.tags || []), ...(definition.tags || [])])],
    stages,
    parameters: filterParameterSchema(definition.parameters || hint.parameters),
    configSchema: jsonObject(definition.configSchema || hint.configSchema || item.manifest?.configSchema),
    effects: normalizeEffects(definition.effects || hint.effects),
    apply: definition.apply,
  }
}

class CustomFilterManager {
  catalog: AnyRecord[] = []
  disposers: Array<() => unknown | Promise<unknown>> = []

  async dispose() {
    const disposers = this.disposers.splice(0)
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (err) {
        hostRuntime.logger?.warn?.("[yui-chat] 自定义过滤器释放失败", err)
      }
    }
  }

  async ensureDir() {
    await customFilterStorage.ensure()
  }

  packagePaths(filterId: unknown): { id: string; dir: string; manifestFile: string; indexFile: string } {
    const id = sanitizeId(filterId)
    if (!id) throw new Error("filterId is required")
    const dir = customFilterStorage.packageDir(id)
    return {
      id,
      dir,
      manifestFile: path.join(dir, "filter.json"),
      indexFile: path.join(dir, "index.js"),
    }
  }

  async listPackages() {
    await this.ensureDir()
    const entries = await fs.readdir(customFiltersDir, { withFileTypes: true })
    const packages: PackageItem[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(customFiltersDir, entry.name)
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(dir, "filter.json"), "utf8"))
        const validation = validateCustomFilterManifest(manifest)
        packages.push({
          id: entry.name,
          dir,
          manifest,
          enabled: manifest.enabled !== false,
          validation,
          filters: Array.isArray(manifest.filters) ? manifest.filters : [],
        })
      } catch (err) {
        packages.push({ id: entry.name, dir, enabled: false, error: errorMessage(err), filters: [] })
      }
    }
    this.catalog = packages.map(item => ({
      id: item.id,
      enabled: item.enabled,
      name: item.manifest?.name || item.id,
      description: item.manifest?.description || "",
      descriptionZh: item.manifest?.descriptionZh || "",
      tags: item.manifest?.tags || [],
      validation: item.validation,
      filters: item.filters,
      error: item.error,
      frameworkResources: resourceSummaries(item.manifest),
    }))
    return packages
  }

  async instantiatePackage(item: PackageItem): Promise<{ filters: FilterDefinition[]; dispose: (() => unknown | Promise<unknown>) | null; framework: AnyRecord }> {
    const framework = createFrameworkResourceAccess(item.manifest?.frameworkResources, { packageId: item.id })
    const mod = await import(`${pathToFileURL(path.join(item.dir, "index.js")).href}?t=${Date.now()}`)
    const exported = typeof mod.createFilters === "function"
      ? await mod.createFilters({ packageId: item.id, manifest: item.manifest, framework })
      : mod.filters
    const filterList = Array.isArray(exported) ? exported : exported?.filters
    const dispose = exported?.dispose || mod.dispose || mod.destroy
    if (!Array.isArray(filterList)) throw new Error(`Custom 过滤器包 ${item.id} 必须导出 filters 数组或 createFilters()`)
    const hints = filterHintMap(item.manifest)
    const filters = filterList.map(definition => normalizeFilterDefinition(definition, hints.get(String(definition?.id || "").trim()), item))
    const ids = new Set()
    for (const filter of filters) {
      if (ids.has(filter.id)) throw new Error(`Custom 过滤器包 ${item.id} 导出了重复 ID：${filter.id}`)
      ids.add(filter.id)
    }
    return { filters, dispose: typeof dispose === "function" ? dispose as () => unknown | Promise<unknown> : null, framework: framework as AnyRecord }
  }

  async loadFilters() {
    await this.dispose()
    const packages = await this.listPackages()
    const filters: FilterDefinition[] = []
    const errors: AnyRecord[] = []
    const loadedIds = new Set()
    for (const item of packages) {
      if (!item.enabled) continue
      if (!item.validation?.ok) {
        errors.push({ packageId: item.id, error: "manifest validation failed", validation: item.validation })
        continue
      }
      try {
        const loaded = await this.instantiatePackage(item)
        if (loaded.dispose) this.disposers.push(loaded.dispose)
        for (const filter of loaded.filters) {
          if (loadedIds.has(filter.id)) {
            errors.push({ packageId: item.id, filterId: filter.id, error: `过滤器 ID ${filter.id} 已由其它 Custom 包使用` })
            continue
          }
          loadedIds.add(filter.id)
          filters.push(filter)
        }
      } catch (err) {
        errors.push({ packageId: item.id, error: errorMessage(err) })
      }
    }
    return { filters, errors }
  }

  async testFilter(packageId: unknown, filterId: unknown, payload: AnyRecord = {}, context: AnyRecord = {}): Promise<AnyRecord & { effects: string[] }> {
    const packages = await this.listPackages()
    const item = packages.find(entry => entry.id === sanitizeId(packageId))
    if (!item) throw new Error(`Custom filter package ${packageId} not found`)
    if (!item.validation?.ok) throw new Error(item.validation?.errors?.[0]?.message || "manifest validation failed")
    const loaded = await this.instantiatePackage(item)
    try {
      const filter = loaded.filters.find(entry => entry.id === String(filterId || "").trim())
      if (!filter) throw new Error(`过滤器 ${filterId} 不存在，可选：${loaded.filters.map(entry => entry.id).join("、") || "无"}`)
      const params = jsonObject(payload.params)
      delete params.text
      const stored = context.config?.response?.messageFilters?.runtimeVariables?.[filter.id]
      const filterConfig = {
        ...toolConfigDefaults(filter.configSchema),
        ...jsonObject(stored),
        ...jsonObject(context.runtimeConfig),
      }
      const stage = filter.stages.includes(context.stage) ? context.stage : filter.stages[0]
      const execution = await runExecutionTest({
        schema: filterParameterSchema(filter.parameters),
        args: params,
        context,
        timeoutMs: context.timeoutMs,
        execute: runtimeContext => filter.apply({ text: String(payload.text || ""), params }, {
          ...context,
          ...runtimeContext,
          source: "web-custom-filter-test",
          dryRun: true,
          filterId: filter.id,
          stage,
          filterConfig,
        }),
      })
      return {
        packageId: item.id,
        filter: filter.id,
        stage,
        stages: filter.stages,
        effects: filter.effects,
        result: execution.serialized,
        durationMs: execution.durationMs,
      }
    } finally {
      if (loaded.dispose) await loaded.dispose()
    }
  }

  async createTemplate(filterId = "text-filter") {
    await this.ensureDir()
    const id = sanitizeId(filterId) || "text-filter"
    const { dir, manifestFile, indexFile } = this.packagePaths(id)
    await createPackageDir(dir, id)
    const implementationId = `${id.replace(/-/g, "_")}_transform`
    const manifest: AnyRecord = {
      id,
      name: `${id} Filter Package`,
      version: "1.0.0",
      enabled: true,
      description: "Yui Chat custom code filter package template",
      descriptionZh: "用于在模型前或发送前确定性处理正文的 Custom 代码过滤器模板。",
      tags: ["template"],
      configSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", title: "附加前缀", default: "" },
        },
      },
      filters: [
        {
          id: implementationId,
          displayName: "文本处理示例",
          displayNameZh: "文本处理示例",
          description: "Adds an optional configured prefix to the current text.",
          descriptionZh: "给当前正文添加一个可配置前缀。",
          stages: ["input", "output"],
          effects: ["pure"],
          parameters: {
            type: "object",
            properties: {},
          },
        },
      ],
    }
    const source = `export function createFilters({ packageId, manifest, framework }) {
  return [
    {
      id: ${JSON.stringify(implementationId)},
      displayNameZh: "文本处理示例",
      description: "给当前正文添加一个可配置前缀。",
      stages: ["input", "output"],
      effects: ["pure"],
      parameters: { type: "object", properties: {} },
      // 管理员在代码过滤器页面保存的运行变量会以 context.filterConfig 注入。
      // 如需复用已声明框架资源，请使用 framework.importModule()/readText() 等方法。
      async apply({ text }, context = {}) {
        const prefix = String(context.filterConfig?.prefix || "")
        return { kind: "text", text: \`\${prefix}\${text}\` }
      },
    },
  ]
}
`
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await fs.writeFile(indexFile, source, "utf8")
    return { id, manifestFile, indexFile, filterId: implementationId }
  }

  async setPackageEnabled(filterId: unknown, enabled: unknown): Promise<AnyRecord> {
    const { id, manifestFile } = this.packagePaths(filterId)
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"))
    manifest.enabled = Boolean(enabled)
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    return { id, enabled: manifest.enabled }
  }

  async getPackage(filterId: unknown): Promise<AnyRecord> {
    const { id, dir, manifestFile, indexFile } = this.packagePaths(filterId)
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"))
    const source = await fs.readFile(indexFile, "utf8")
    const validation = validateCustomFilterManifest(manifest)
    return { id, dir, manifestFile, indexFile, manifest, source, validation }
  }

  async updatePackage(filterId: unknown, payload: AnyRecord = {}): Promise<AnyRecord> {
    const { id, manifestFile, indexFile } = this.packagePaths(filterId)
    const manifest = isObject(payload.manifest) ? cloneJsonValue(payload.manifest) as AnyRecord : null
    const source = typeof payload.source === "string" ? payload.source : null
    if (!manifest) throw new Error("manifest is required")
    if (source === null) throw new Error("source is required")
    manifest.id = id
    const validation = validateCustomFilterManifest(manifest)
    if (!validation.ok) {
      const first = validation.errors?.[0]
      throw new Error(first ? `${first.path}: ${first.message}` : "custom filter manifest validation failed")
    }
    const occupied = new Set((await this.listPackages())
      .filter(item => item.id !== id)
      .flatMap(item => item.filters || [])
      .map(filter => String(filter?.id || "").trim())
      .filter(Boolean))
    const duplicate = (manifest.filters || []).map((filter: AnyRecord) => String(filter?.id || "").trim()).find((filter: string) => occupied.has(filter))
    if (duplicate) throw new Error(`过滤器 id “${duplicate}” 已被其它 Custom 包使用`)
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await fs.writeFile(indexFile, source.endsWith("\n") ? source : `${source}\n`, "utf8")
    return this.getPackage(id)
  }

  async referencesForPackage(filterId: unknown, config: AnyRecord = {}): Promise<AnyRecord[]> {
    const { id } = this.packagePaths(filterId)
    const item = (await this.listPackages()).find(entry => entry.id === id)
    if (!item) throw new Error(`Custom filter package ${filterId} not found`)
    const implementationIds = new Set((item.filters || []).map((filter: AnyRecord) => String(filter?.id || "").trim()).filter(Boolean))
    const rules = Array.isArray(config.response?.messageFilters?.filters) ? config.response.messageFilters.filters as AnyRecord[] : []
    return rules
      .filter((rule: AnyRecord) => rule?.implementation?.type === "filter" && implementationIds.has(String(rule.implementation.id || "")))
      .map((rule: AnyRecord) => ({ id: String(rule.id || ""), name: String(rule.name || rule.id || ""), implementationId: String(rule.implementation.id || "") }))
  }

  async deletePackage(filterId: unknown, config: AnyRecord = {}): Promise<AnyRecord> {
    const { id, dir } = this.packagePaths(filterId)
    const references = await this.referencesForPackage(id, config)
    if (references.length) {
      throw packageError(`Custom 过滤器包 ${id} 正被 ${references.length} 条规则引用，请先替换或删除这些规则。`, {
        statusCode: 409,
        references,
      })
    }
    await fs.rm(dir, { recursive: true, force: true })
    return { id, deleted: true }
  }

  applyRuntimeConfigUpdate(filter: AnyRecord = {}, incoming: unknown = {}, current: unknown = {}): AnyRecord {
    return applyToolRuntimeConfigUpdate({ name: filter.id, configSchema: filter.configSchema }, incoming, current)
  }
}

export const customFilterManager = new CustomFilterManager()
