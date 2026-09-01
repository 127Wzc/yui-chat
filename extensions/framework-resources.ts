import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { yunzaiRoot } from "../config/store.js"

type UnknownRecord = Record<string, unknown>
type ResourceType = "module" | "text" | "json"
type ResourceScope = "plugin" | "yunzai"

export interface FrameworkResourceDeclaration {
  alias: string
  scope: ResourceScope
  type: ResourceType
  plugin: string
  path: string
  description: string
}

interface ResolvedResource extends FrameworkResourceDeclaration {
  root: string
  target: string
}

export interface FrameworkResourceAccess {
  list(): FrameworkResourceDeclaration[]
  resolvePath(alias: string): string
  readText(alias: string, options?: { maxBytes?: number }): Promise<string>
  readSource(alias: string, options?: { maxBytes?: number }): Promise<string>
  readJson(alias: string, options?: { maxBytes?: number }): Promise<unknown>
  importModule(alias: string): Promise<UnknownRecord>
  pickExport(alias: string, exportName?: string): Promise<unknown>
  use(alias: string): Promise<unknown>
}

export interface FrameworkBrowseEntry {
  name: string
  path: string
  kind: "directory" | "file"
  type?: ResourceType
  reference?: string
}

const RESOURCE_TYPES = new Set<ResourceType>(["module", "text", "json"])
const RESOURCE_SCOPES = new Set<ResourceScope>(["plugin", "yunzai"])
const DEFAULT_MAX_BYTES = 1024 * 1024
const BROWSABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".txt", ".yaml", ".yml"])
const HIDDEN_DIRECTORY_NAMES = new Set([".git", "node_modules", "data", "cache"])

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function posixPath(value: unknown = ""): string {
  return text(value).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
}

function resourceTypeForPath(value: string): ResourceType {
  const extension = path.extname(value).toLowerCase()
  if (extension === ".json") return "json"
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "module"
  return "text"
}

function isSensitiveBrowserEntry(relativePath: string, name: string): boolean {
  const parts = posixPath(relativePath).split("/").filter(Boolean)
  if (parts.length === 1 && ["config", "data", "cache"].includes(parts[0] || "")) return true
  if (HIDDEN_DIRECTORY_NAMES.has(name) || name.startsWith(".")) return true
  return /^config(?:\.[^.]+)?\.json$/i.test(name)
    || /^(?:credentials?|secrets?|tokens?|api[-_]?keys?)\.(?:json|ya?ml|txt)$/i.test(name)
}

function referenceForProjectPath(relativePath: string): string {
  const normalized = posixPath(relativePath)
  const parts = normalized.split("/")
  if (parts[0] === "plugins" && parts[1] && parts.length > 2) return `plugin:${parts[1]}/${parts.slice(2).join("/")}`
  return `yunzai:${normalized}`
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeDeclarations(input: unknown): UnknownRecord {
  return isRecord(input) ? input : {}
}

function validateAlias(alias: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) throw new Error(`资源别名不合法：${alias}`)
}

function parseShorthand(value: string): UnknownRecord {
  const raw = value.trim()
  const pluginMatch = raw.match(/^plugin:([^/\\]+)[/\\](.+)$/)
  const yunzaiMatch = raw.match(/^yunzai:(.+)$/)
  if (!pluginMatch && !yunzaiMatch) throw new Error("短写法应为 plugin:插件名/相对路径 或 yunzai:相对路径")
  const resourcePath = (pluginMatch?.[2] || yunzaiMatch?.[1] || "").replace(/\\/g, "/")
  const extension = path.extname(resourcePath).toLowerCase()
  return {
    scope: pluginMatch ? "plugin" : "yunzai",
    ...(pluginMatch ? { plugin: pluginMatch[1] } : {}),
    path: resourcePath,
    type: extension === ".json" ? "json" : [".js", ".mjs", ".cjs"].includes(extension) ? "module" : "text",
  }
}

function resolveDeclaration(alias: string, input: unknown): ResolvedResource {
  validateAlias(alias)
  const declaration = typeof input === "string" ? parseShorthand(input) : record(input)
  if (!isRecord(declaration)) throw new Error(`资源 ${alias} 声明必须是对象`)
  const scopeValue = text(declaration.scope || "plugin")
  const typeValue = text(declaration.type || "module")
  if (!RESOURCE_SCOPES.has(scopeValue as ResourceScope)) throw new Error(`资源 ${alias} scope 只支持 plugin / yunzai`)
  if (!RESOURCE_TYPES.has(typeValue as ResourceType)) throw new Error(`资源 ${alias} type 只支持 module / text / json`)
  const scope = scopeValue as ResourceScope
  const type = typeValue as ResourceType
  const relativePath = text(declaration.path).trim()
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`资源 ${alias} path 必须是相对路径`)

  let root: string
  let plugin = ""
  if (scope === "plugin") {
    plugin = text(declaration.plugin).trim()
    if (!plugin || plugin === "." || plugin === ".." || plugin.includes("/") || plugin.includes("\\")) throw new Error(`资源 ${alias} 必须声明合法的 plugin 目录名`)
    root = path.join(yunzaiRoot, "plugins", plugin)
  } else {
    root = yunzaiRoot
  }
  const target = path.resolve(root, relativePath)
  if (!isInside(target, root)) throw new Error(`资源 ${alias} 不能超出声明范围`)
  return { alias, scope, type, plugin, path: relativePath, description: text(declaration.description), root, target }
}

export function validateFrameworkResources(input: unknown = {}): Array<{ level: "error"; path: string; message: string }> {
  if (input === undefined) return []
  if (!isRecord(input)) return [{ level: "error", path: "frameworkResources", message: "frameworkResources must be an object" }]
  const issues: Array<{ level: "error"; path: string; message: string }> = []
  for (const [alias, declaration] of Object.entries(input)) {
    try {
      resolveDeclaration(alias, declaration)
    } catch (error) {
      issues.push({ level: "error", path: `frameworkResources.${alias}`, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return issues
}

export function createFrameworkResourceAccess(input: unknown = {}, options: UnknownRecord = {}): FrameworkResourceAccess {
  const declarations = normalizeDeclarations(input)
  const resolved = new Map<string, ResolvedResource>(Object.entries(declarations).map(([alias, declaration]) => [alias, resolveDeclaration(alias, declaration)]))

  function get(alias: string): ResolvedResource {
    const item = resolved.get(String(alias))
    if (!item) throw new Error(`Custom 包 ${text(options.packageId) || "unknown"} 未声明框架资源：${alias}`)
    return item
  }

  async function assertFile(item: ResolvedResource): Promise<{ stat: Awaited<ReturnType<typeof fs.stat>>; realTarget: string }> {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(item.root), fs.realpath(item.target)])
    if (!isInside(realTarget, realRoot)) throw new Error(`资源 ${item.alias} 的真实路径超出声明范围`)
    const stat = await fs.stat(realTarget)
    if (!stat.isFile()) throw new Error(`框架资源不是文件：${item.path}`)
    return { stat, realTarget }
  }

  function list(): FrameworkResourceDeclaration[] {
    return [...resolved.values()].map(({ target: _target, root: _root, ...item }) => ({ ...item }))
  }

  function resolvePath(alias: string): string {
    return get(alias).target
  }

  async function readSource(alias: string, options: { maxBytes?: number } = {}): Promise<string> {
    const item = get(alias)
    const { stat, realTarget } = await assertFile(item)
    const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_BYTES))
    if (stat.size > maxBytes) throw new Error(`资源 ${alias} 超过读取上限 ${maxBytes} bytes`)
    return fs.readFile(realTarget, "utf8")
  }

  async function readText(alias: string, options: { maxBytes?: number } = {}): Promise<string> {
    if (get(alias).type === "module") throw new Error(`资源 ${alias} 是 module，请使用 importModule()`)
    return readSource(alias, options)
  }

  async function readJson(alias: string, options: { maxBytes?: number } = {}): Promise<unknown> {
    if (get(alias).type !== "json") throw new Error(`资源 ${alias} 不是 json`)
    return JSON.parse(await readText(alias, options)) as unknown
  }

  async function importModule(alias: string): Promise<UnknownRecord> {
    if (get(alias).type !== "module") throw new Error(`资源 ${alias} 不是 module`)
    const { realTarget } = await assertFile(get(alias))
    return await import(`${pathToFileURL(realTarget).href}?custom_resource=${Date.now()}`) as UnknownRecord
  }

  async function pickExport(alias: string, exportName = "default"): Promise<unknown> {
    const module = await importModule(alias)
    if (!Object.hasOwn(module, exportName)) throw new Error(`资源 ${alias} 不存在导出：${exportName}`)
    return module[exportName]
  }

  async function use(alias: string): Promise<unknown> {
    const item = get(alias)
    if (item.type === "module") return importModule(alias)
    if (item.type === "json") return readJson(alias)
    return readText(alias)
  }

  return Object.freeze({ list, resolvePath, readText, readSource, readJson, importModule, pickExport, use })
}

export async function browseFrameworkResourceDirectory(relativePath = ""): Promise<{ root: string; path: string; parent: string; entries: FrameworkBrowseEntry[]; truncated: boolean }> {
  const normalized = posixPath(relativePath)
  if (normalized.split("/").includes("..")) throw new Error("项目路径不能包含上级目录")
  const target = path.resolve(yunzaiRoot, normalized)
  if (!isInside(target, yunzaiRoot)) throw new Error("项目路径超出 Yunzai 目录")
  const [realRoot, realTarget] = await Promise.all([fs.realpath(yunzaiRoot), fs.realpath(target)])
  if (!isInside(realTarget, realRoot)) throw new Error("项目路径的真实位置超出 Yunzai 目录")
  const stat = await fs.stat(realTarget)
  if (!stat.isDirectory()) throw new Error("请选择项目文件夹")
  const entries: FrameworkBrowseEntry[] = []
  for (const entry of await fs.readdir(realTarget, { withFileTypes: true })) {
    const childPath = posixPath(path.posix.join(normalized, entry.name))
    if (entry.isSymbolicLink?.() || isSensitiveBrowserEntry(childPath, entry.name)) continue
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, path: childPath, kind: "directory" })
      continue
    }
    if (!entry.isFile() || !BROWSABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    entries.push({ name: entry.name, path: childPath, kind: "file", type: resourceTypeForPath(entry.name), reference: referenceForProjectPath(childPath) })
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
    return left.name.localeCompare(right.name, "zh-CN")
  })
  const parent = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : ""
  return { root: "Yunzai", path: normalized, parent, entries: entries.slice(0, 300), truncated: entries.length > 300 }
}
