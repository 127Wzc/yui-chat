import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { escapeRegExp } from "../core/message/command-prefixes.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { safeText } from "./command-document-builder.js"

type UnknownRecord = Record<string, unknown>

interface CommandItem extends UnknownRecord {
  key?: unknown
}

interface PluginInfo extends UnknownRecord {
  name?: unknown
}

interface RuleInfo extends UnknownRecord {
  fnc?: unknown
}

interface SourceLocation {
  file: string
  fileRole: string
}

export interface CommandSourceOrigin {
  type: "runtime-plugin-rule"
  label: string
  pluginKey: string
  pluginName: string
  file: string
  fileRole: string
  method: string
}

const yunzaiPluginsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const pluginSourceFileLimit = 400
const pluginSourceDepth = 4
const pluginSourceMaxBytes = 512 * 1024
const ignoredPluginSourceDirectories = new Set([".git", "cache", "data", "logs", "node_modules", "resources"])
const pluginSourceFiles = new Map<string, Promise<string[]>>()
const pluginSourceContents = new Map<string, Promise<string>>()
const pluginMethodSourceFiles = new Map<string, Promise<SourceLocation>>()

function pluginSourceFile(pluginKey: unknown = ""): string {
  const key = safeText(pluginKey).replace(/\\/g, "/").replace(/^\/+/, "")
  if (!key || key.split("/").some(part => part === "." || part === "..")) return ""
  return `plugins/${key}${key.endsWith(".js") ? "" : "/index.js"}`
}

function pluginSourcePath(pluginKey: unknown = ""): string {
  const key = safeText(pluginKey).replace(/\\/g, "/").replace(/^\/+/, "")
  if (!key || key.split("/").some(part => part === "." || part === "..")) return ""
  const candidate = path.resolve(yunzaiPluginsDir, key)
  return candidate === yunzaiPluginsDir || candidate.startsWith(`${yunzaiPluginsDir}${path.sep}`) ? candidate : ""
}

function sourceFileLabel(file: string = ""): string {
  const relative = path.relative(path.dirname(yunzaiPluginsDir), file)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : ""
}

async function collectPluginSourceFiles(pluginKey: unknown = ""): Promise<string[]> {
  const root = pluginSourcePath(pluginKey)
  if (!root) return []
  try {
    const stat = await fs.stat(root)
    if (stat.isFile()) return /\.[cm]?js$/i.test(root) ? [root] : []
    if (!stat.isDirectory()) return []
    const files: string[] = []
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > pluginSourceDepth || files.length >= pluginSourceFileLimit) return
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (files.length >= pluginSourceFileLimit) return
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!ignoredPluginSourceDirectories.has(entry.name)) await visit(target, depth + 1)
        } else if (entry.isFile() && /\.[cm]?js$/i.test(entry.name)) {
          files.push(target)
        }
      }
    }
    await visit(root, 0)
    return files
  } catch (error) {
    // 来源定位只是展示增强；无法读取外部插件源码时保留运行时入口，不影响指令扫描。
    hostRuntime.logger?.debug?.("[yui-chat] 指令来源文件扫描失败，已回退到插件入口", error)
    return []
  }
}

function sourcesForPlugin(pluginKey: unknown = ""): Promise<string[]> {
  const key = safeText(pluginKey)
  if (!pluginSourceFiles.has(key)) pluginSourceFiles.set(key, collectPluginSourceFiles(key))
  return pluginSourceFiles.get(key) as Promise<string[]>
}

function sourceContent(file: string = ""): Promise<string> {
  if (!pluginSourceContents.has(file)) {
    pluginSourceContents.set(file, fs.stat(file).then(stat => {
      if (stat.size > pluginSourceMaxBytes) return ""
      return fs.readFile(file, "utf8")
    }).catch(error => {
      // 单个文件无法读取不应中断已有运行态规则；调用方会继续检查其余候选文件。
      hostRuntime.logger?.debug?.("[yui-chat] 指令来源文件读取失败", error)
      return ""
    }))
  }
  return pluginSourceContents.get(file) as Promise<string>
}

function methodDeclarationPattern(method: unknown = ""): RegExp | null {
  const name = safeText(method)
  if (!name) return null
  return new RegExp(`(?:^|[\\s;{}])(?:async\\s+)?${escapeRegExp(name)}\\s*\\(`, "m")
}

async function findRuntimeMethodSourceFile(pluginKey: unknown = "", method: unknown = ""): Promise<SourceLocation> {
  const fallback = pluginSourceFile(pluginKey)
  const pattern = methodDeclarationPattern(method)
  if (!pattern) return { file: fallback, fileRole: "插件入口" }
  for (const file of await sourcesForPlugin(pluginKey)) {
    const source = await sourceContent(file)
    if (pattern.test(source)) return { file: sourceFileLabel(file) || fallback, fileRole: "方法实现" }
  }
  return { file: fallback, fileRole: "插件入口" }
}

function runtimeMethodSourceFile(pluginKey: unknown = "", method: unknown = ""): Promise<SourceLocation> {
  const key = `${safeText(pluginKey)}\u0000${safeText(method)}`
  if (!pluginMethodSourceFiles.has(key)) pluginMethodSourceFiles.set(key, findRuntimeMethodSourceFile(pluginKey, method))
  return pluginMethodSourceFiles.get(key) as Promise<SourceLocation>
}

export async function runtimeRuleOrigin(item: CommandItem = {}, plugin: PluginInfo = {}, rule: RuleInfo = {}): Promise<CommandSourceOrigin> {
  const source = await runtimeMethodSourceFile(item.key, rule.fnc)
  return {
    type: "runtime-plugin-rule",
    label: "Yunzai 插件规则",
    pluginKey: safeText(item.key),
    pluginName: safeText(plugin.name),
    file: source.file,
    fileRole: source.fileRole,
    method: safeText(rule.fnc),
  }
}

export function resetCommandSourceLocator(): void {
  pluginSourceFiles.clear()
  pluginSourceContents.clear()
  pluginMethodSourceFiles.clear()
}
