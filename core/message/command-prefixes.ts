import type { UnknownRecord } from "./types.js"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

export function escapeRegExp(value: unknown = ""): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Yui Chat 指令的唯一前缀定义；第一人称触发不经过这里。 */
export const PLUGIN_COMMAND_PREFIX_PATTERN = /^#yui/

/** 从唯一前缀正则派生可展示文本，避免再维护一份字符串常量。 */
export const PLUGIN_COMMAND_PREFIX = PLUGIN_COMMAND_PREFIX_PATTERN.source.replace(/^\^/, "")

/** 生成 Yunzai rule 使用的完整正则字符串。 */
export function pluginCommandRule(suffixPattern = ""): string {
  return `${PLUGIN_COMMAND_PREFIX_PATTERN.source}${suffixPattern}$`
}

/** 生成回复、帮助和管理台展示使用的完整指令。 */
export function pluginCommand(suffix = ""): string {
  return `${PLUGIN_COMMAND_PREFIX}${suffix}`
}

/** 使用统一前缀匹配某条插件指令。 */
export function matchPluginCommand(message: unknown, suffixPattern = ""): RegExpMatchArray | null {
  return String(message || "").match(new RegExp(pluginCommandRule(suffixPattern)))
}

/** 去掉统一前缀和固定指令名，只保留用户参数。 */
export function stripPluginCommand(message: unknown, commandName = ""): string {
  const pattern = `${PLUGIN_COMMAND_PREFIX_PATTERN.source}${escapeRegExp(commandName)}`
  return String(message || "").replace(new RegExp(pattern), "").trim()
}

export function commandPrefixes(config: unknown = {}): string[] {
  const knowledge = record(record(config).knowledge)
  const prefixes = Array.isArray(knowledge.commandPrefixes) ? knowledge.commandPrefixes : ["#", "/", "*"]
  return [...new Set(prefixes.map(item => String(item || "").trim()).filter(Boolean))].slice(0, 12)
}

export function isCommandMessage(text: unknown = "", configOrPrefixes: unknown = {}): boolean {
  const prefixes = Array.isArray(configOrPrefixes) ? configOrPrefixes.map(String) : commandPrefixes(configOrPrefixes)
  return prefixes.some(prefix => String(text || "").startsWith(prefix))
}

export function commandHead(text: unknown = "", configOrPrefixes: unknown = {}): string {
  const safe = String(text || "").replace(/\s+/g, " ").trim()
  const prefixes = Array.isArray(configOrPrefixes) ? configOrPrefixes.map(String) : commandPrefixes(configOrPrefixes)
  const prefixPattern = prefixes.map(escapeRegExp).join("|")
  const match = prefixPattern ? safe.match(new RegExp(`^(?:${prefixPattern})\\S{1,80}`)) : null
  if (!match) return ""
  return match[0].replace(/[，。；;、!?？！]+$/, "")
}
