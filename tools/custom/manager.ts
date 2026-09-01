import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { pluginRoot } from "../../config/store.js"
import { createUserExtensionStorage, type UserExtensionStorage } from "../../extensions/storage.js"
import { getToolCommon, normalizeTool, type NormalizedTool } from "../support/contract.js"
import { validateExtensionManifest, type ExtensionValidation } from "../../extensions/validator.js"
import { createFrameworkResourceAccess, type FrameworkResourceAccess } from "../../extensions/framework-resources.js"
import { deriveExtensionId, sanitizeIdentifier } from "../../core/shared/identifiers.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { cloneJsonValue } from "../../core/shared/json-values.js"
import { resolveToolRuntimeConfig } from "../../extensions/runtime-config.js"

type UnknownRecord = Record<string, unknown>
type DynamicDisposer = () => Promise<unknown> | unknown

interface CustomPackage {
  id: string
  dir: string
  manifest: UnknownRecord
  enabled: boolean
  validation?: ExtensionValidation
  tools: unknown[]
  error?: string
}

interface LoadedPackage {
  tools: NormalizedTool[]
  dispose: DynamicDisposer | null
  framework: FrameworkResourceAccess
}

interface CustomToolManagerContext extends UnknownRecord {
  packageId?: string
  manifest?: UnknownRecord
  framework?: FrameworkResourceAccess
  config?: unknown
  runtimeConfig?: unknown
  timeoutMs?: unknown
}

const customToolStorage: UserExtensionStorage = createUserExtensionStorage({
  domain: "tools",
  manifestFile: "tool.json",
  seedDirs: [path.join(pluginRoot, "examples", "extensions", "tools")],
})
export const customToolsDir = customToolStorage.dir

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const sanitizeId = (value: unknown): string => sanitizeIdentifier(value, 64)

async function createPackageDir(dir: string, id: string): Promise<void> {
  try {
    await fs.mkdir(dir)
  } catch (error) {
    if (record(error).code === "EEXIST") throw new Error(`Custom 工具 ID “${id}” 已存在`)
    throw error
  }
}

function serializableResult(value: unknown): unknown {
  if (value === undefined) return null
  const seen = new WeakSet<object>()
  try {
    return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString()
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })) as unknown
  } catch {
    return String(value)
  }
}

/** Custom 工具管理器；只有用户入口模块保留 JS 动态加载，管理和安全校验由 TS 负责。 */
export class CustomToolManager {
  catalog: UnknownRecord[] = []
  private disposers: DynamicDisposer[] = []

  async dispose(): Promise<void> {
    const disposers = this.disposers.splice(0)
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (error) {
        hostRuntime.logger?.warn?.("[yui-chat] 自定义工具释放失败", error)
      }
    }
  }

  async ensureDir(): Promise<void> {
    await customToolStorage.ensure()
  }

  packagePaths(toolId: unknown): { id: string; dir: string; manifestFile: string; indexFile: string } {
    const id = sanitizeId(toolId)
    if (!id) throw new Error("toolId is required")
    const dir = customToolStorage.packageDir(id)
    return { id, dir, manifestFile: path.join(dir, "tool.json"), indexFile: path.join(dir, "index.js") }
  }

  async listPackages(): Promise<CustomPackage[]> {
    await this.ensureDir()
    const entries = await fs.readdir(customToolsDir, { withFileTypes: true })
    const packages: CustomPackage[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(customToolsDir, entry.name)
      try {
        const manifest = record(JSON.parse(await fs.readFile(path.join(dir, "tool.json"), "utf8")))
        const validation = validateExtensionManifest(manifest, { type: "custom-tool" })
        packages.push({ id: entry.name, dir, manifest, enabled: manifest.enabled !== false, validation, tools: Array.isArray(manifest.tools) ? manifest.tools : [] })
      } catch (error) {
        packages.push({ id: entry.name, dir, manifest: {}, enabled: false, error: errorMessage(error), tools: [] })
      }
    }
    this.catalog = packages.map(item => {
      const manifest = item.manifest
      const frameworkResources = Object.entries(record(manifest.frameworkResources)).map(([alias, value]) => (
        typeof value === "string" ? { alias, reference: value } : { alias, ...record(value) }
      ))
      return {
        id: item.id,
        enabled: item.enabled,
        name: text(manifest.name) || item.id,
        description: text(manifest.description),
        descriptionZh: text(manifest.descriptionZh),
        category: text(manifest.category) || "custom",
        risk: text(manifest.risk) || "medium",
        tags: Array.isArray(manifest.tags) ? manifest.tags : [],
        validation: item.validation,
        tools: item.tools,
        error: item.error,
        frameworkResources,
      }
    })
    return packages
  }

  async instantiatePackage(item: CustomPackage): Promise<LoadedPackage> {
    const framework = createFrameworkResourceAccess(item.manifest.frameworkResources, { packageId: item.id })
    const mod = await import(`${pathToFileURL(path.join(item.dir, "index.js")).href}?t=${Date.now()}`) as unknown as UnknownRecord
    const createTools = mod.createTools
    const exportedTools = typeof createTools === "function"
      ? await (createTools as (context: UnknownRecord) => Promise<unknown> | unknown)({ packageId: item.id, manifest: item.manifest, framework })
      : mod.tools
    const exportedRecord = record(exportedTools)
    const toolList = Array.isArray(exportedTools) ? exportedTools : Array.isArray(exportedRecord.tools) ? exportedRecord.tools : []
    const disposeCandidate = exportedRecord.dispose || mod.dispose || mod.destroy
    const tools: NormalizedTool[] = []
    const manifestTools = records(item.manifest.tools)
    for (const tool of toolList) {
      const common = getToolCommon(tool)
      const toolRecord = record(tool)
      const manifestTool = manifestTools.find(candidate => candidate.name === toolRecord.name) || {}
      const normalized = normalizeTool(tool, {
        source: "custom",
        packageId: item.id,
        packageName: text(item.manifest.name) || item.id,
        displayNameZh: text(common.displayNameZh || common.nameZh || item.manifest.displayNameZh || item.manifest.nameZh),
        descriptionZh: text(common.descriptionZh || item.manifest.descriptionZh),
        category: text(common.category || item.manifest.category) || "custom",
        categoryLabel: text(common.categoryLabel || item.manifest.categoryLabel) || "自定义",
        risk: text(common.risk || item.manifest.risk) || "medium",
        tags: [...(Array.isArray(item.manifest.tags) ? item.manifest.tags : []), ...(Array.isArray(common.tags) ? common.tags : [])],
        policy: { ...record(item.manifest.policy), ...record(common.policy) },
        configSchema: common.configSchema || item.manifest.configSchema,
        delivery: common.delivery || manifestTool.delivery || item.manifest.delivery,
        requiresFinalReply: common.requiresFinalReply ?? manifestTool.requiresFinalReply ?? item.manifest.requiresFinalReply,
        execution: common.execution ?? manifestTool.execution ?? item.manifest.execution,
        executionByAction: common.executionByAction || manifestTool.executionByAction || item.manifest.executionByAction,
        pipeline: common.pipeline || manifestTool.pipeline || item.manifest.pipeline,
      })
      if (normalized) tools.push(normalized)
    }
    return { tools, dispose: typeof disposeCandidate === "function" ? disposeCandidate as DynamicDisposer : null, framework }
  }

  async loadTools(): Promise<{ tools: NormalizedTool[]; errors: UnknownRecord[] }> {
    await this.dispose()
    const packages = await this.listPackages()
    const tools: NormalizedTool[] = []
    const errors: UnknownRecord[] = []
    for (const item of packages) {
      if (!item.enabled) continue
      if (item.validation && !item.validation.ok) {
        errors.push({ packageId: item.id, error: "manifest validation failed", validation: item.validation })
        continue
      }
      try {
        const loaded = await this.instantiatePackage(item)
        if (loaded.dispose) this.disposers.push(loaded.dispose)
        tools.push(...loaded.tools)
      } catch (error) {
        errors.push({ packageId: item.id, error: errorMessage(error) })
      }
    }
    return { tools, errors }
  }

  async testTool(toolId: unknown, toolName: string, args: UnknownRecord = {}, context: CustomToolManagerContext = {}): Promise<UnknownRecord> {
    const packages = await this.listPackages()
    const item = packages.find(entry => entry.id === sanitizeId(toolId))
    if (!item) throw new Error(`Custom tool package ${text(toolId)} not found`)
    if (!item.validation?.ok) throw new Error(item.validation?.errors?.[0]?.message || "manifest validation failed")
    const loaded = await this.instantiatePackage(item)
    try {
      const tool = loaded.tools.find(entry => entry.name === toolName)
      if (!tool) throw new Error(`工具 ${toolName} 不存在，可选：${loaded.tools.map(entry => entry.name).join("、") || "无"}`)
      const timeoutMs = Math.max(1000, Math.min(30000, Number(context.timeoutMs || 15000)))
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        tool.execute(args, {
          ...context,
          source: "web-custom-test",
          dryRun: true,
          toolConfig: { ...resolveToolRuntimeConfig(tool, context.config || {}), ...record(context.runtimeConfig) },
        }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`测试超过 ${timeoutMs}ms`)), timeoutMs) }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
      return {
        packageId: item.id,
        tool: tool.name,
        result: serializableResult(result),
        resultType: result === null ? "null" : Array.isArray(result) ? "array" : typeof result,
      }
    } finally {
      if (loaded.dispose) await loaded.dispose()
    }
  }

  buildTemplate(toolId = "hello-tool"): { id: string; manifest: UnknownRecord; source: string; toolName: string } {
    const id = sanitizeId(toolId) || "hello-tool"
    const toolName = `${id.replace(/-/g, "_")}_echo`
    const manifest: UnknownRecord = {
      id, name: `${id} Tool Package`, enabled: true, description: "Yui Chat custom tool package template",
      category: "custom", risk: "medium", tags: ["template"],
      policy: { requiresMaster: false, requiresGroup: false, requiresGroupAdmin: false, highRisk: false, externalNetwork: false },
      configSchema: { type: "object", properties: { prefix: { type: "string", title: "回显前缀", default: `Custom tool ${id} 收到：` } } },
      tools: [{ name: toolName, description: "Echo input text. Replace this with your own logic.", risk: "low", tags: ["example"], policy: { requiresMaster: false, externalNetwork: false } }],
    }
    const source = `export const tools = [
  {
    name: ${JSON.stringify(toolName)},
    description: "示例自定义工具：回显输入文本。你可以在这里替换成自己的业务逻辑。",
    risk: "low",
    tags: ["example"],
    policy: { requiresMaster: false, requiresGroup: false, requiresGroupAdmin: false, highRisk: false, externalNetwork: false },
    configSchema: {
      type: "object",
      properties: { prefix: { type: "string", title: "回显前缀", default: ${JSON.stringify(`Custom tool ${id} 收到：`)} } }
    },
    parameters: { type: "object", properties: { text: { type: "string", description: "要回显的文本" } }, required: ["text"] },
    async execute(args = {}, context = {}) { return \`${"${context.toolConfig?.prefix || \"\"}"}${"${args.text || \"\"}"}\` }
  }
]
`
    return { id, manifest, source, toolName }
  }

  async createTemplate(toolId = "hello-tool", options: UnknownRecord = {}): Promise<UnknownRecord> {
    const template = this.buildTemplate(toolId)
    if (options.dryRun) return template
    await this.ensureDir()
    const { id, dir, manifestFile, indexFile } = this.packagePaths(template.id)
    await createPackageDir(dir, id)
    await fs.writeFile(manifestFile, `${JSON.stringify(template.manifest, null, 2)}\n`, "utf8")
    await fs.writeFile(indexFile, template.source, "utf8")
    return { id, manifestFile, indexFile, toolName: template.toolName }
  }

  async setPackageEnabled(toolId: unknown, enabled: unknown): Promise<UnknownRecord> {
    const { id, manifestFile } = this.packagePaths(toolId)
    const manifest = record(JSON.parse(await fs.readFile(manifestFile, "utf8")))
    manifest.enabled = Boolean(enabled)
    await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    return { id, enabled: manifest.enabled }
  }

  async getPackage(toolId: unknown): Promise<UnknownRecord> {
    const { id, dir, manifestFile, indexFile } = this.packagePaths(toolId)
    const manifest = record(JSON.parse(await fs.readFile(manifestFile, "utf8")))
    const source = await fs.readFile(indexFile, "utf8")
    const validation = validateExtensionManifest(manifest, { type: "custom-tool" })
    return { id, dir, manifestFile, indexFile, manifest, source, validation }
  }

  // 新建与更新共用同一份校验和去重逻辑，避免两条路径产生不同结构。
  async preparePackage(id: string, payload: UnknownRecord = {}): Promise<{ manifest: UnknownRecord; source: string }> {
    const manifest = isRecord(payload.manifest) ? cloneJsonValue(payload.manifest) : null
    const source = typeof payload.source === "string" ? payload.source : null
    if (!manifest) throw new Error("manifest is required")
    if (source === null) throw new Error("source is required")
    manifest.id = id
    const validation = validateExtensionManifest(manifest, { type: "custom-tool" })
    if (!validation.ok) {
      const first = validation.errors[0]
      throw new Error(first ? `${first.path}: ${first.message}` : "custom tool manifest validation failed")
    }
    const occupied = new Set((await this.listPackages()).filter(item => item.id !== id).flatMap(item => records(item.tools).map(tool => text(tool.name)).filter(Boolean)))
    const duplicate = records(manifest.tools).map(tool => text(tool.name)).find(name => occupied.has(name))
    if (duplicate) throw new Error(`工具 name “${duplicate}” 已被其它 Custom 包使用`)
    return { manifest, source: source.endsWith("\n") ? source : `${source}\n` }
  }

  async createPackage(payload: UnknownRecord = {}): Promise<UnknownRecord> {
    await this.ensureDir()
    const draft = record(payload.manifest)
    const used = (await this.listPackages()).map(item => item.id)
    const firstTool = records(draft.tools)[0]
    const id = deriveExtensionId([firstTool.name, draft.name, draft.displayNameZh], "custom-tool", used)
    const prepared = await this.preparePackage(id, payload)
    const { dir, manifestFile, indexFile } = this.packagePaths(id)
    await createPackageDir(dir, id)
    await fs.writeFile(manifestFile, `${JSON.stringify(prepared.manifest, null, 2)}\n`, "utf8")
    await fs.writeFile(indexFile, prepared.source, "utf8")
    return this.getPackage(id)
  }

  async updatePackage(toolId: unknown, payload: UnknownRecord = {}): Promise<UnknownRecord> {
    const { id, manifestFile, indexFile } = this.packagePaths(toolId)
    const prepared = await this.preparePackage(id, payload)
    await fs.writeFile(manifestFile, `${JSON.stringify(prepared.manifest, null, 2)}\n`, "utf8")
    await fs.writeFile(indexFile, prepared.source, "utf8")
    return this.getPackage(id)
  }

  async deletePackage(toolId: unknown): Promise<UnknownRecord> {
    const { id, dir } = this.packagePaths(toolId)
    await fs.rm(dir, { recursive: true, force: true })
    return { id, deleted: true }
  }
}

export const customToolManager = new CustomToolManager()
