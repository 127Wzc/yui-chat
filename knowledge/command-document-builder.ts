import { cleanCommandRetrievalText } from "./command-retrieval-text.js"
import { commandHead } from "../core/message/command-prefixes.js"
import vm from "node:vm"
import { commandExamplesFromRegexp, validatedCommandExamples } from "./command-regexp-examples.js"

export function boundedCommandMatch(pattern: unknown, input: unknown, _runtime = false, flags = ""): boolean {
  try { return Boolean(new vm.Script(`new RegExp(${JSON.stringify(String(pattern).slice(0, 2000))}, ${JSON.stringify(flags)}).test(input)`).runInNewContext({ input: String(input).slice(0, 4000) }, { timeout: 15 })) } catch { return false }
}

export type UnknownRecord = Record<string, unknown>

/** 无穷优先级是宿主支持的运行值，使用字符串避免 JSON 将其写成 null。 */
export type CommandPriority = number | "Infinity" | "-Infinity"
export function normalizeCommandPriority(value: unknown): CommandPriority | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined
  const number = Number(value)
  if (Number.isNaN(number)) return undefined
  return number === Infinity ? "Infinity" : number === -Infinity ? "-Infinity" : number
}

export function commandPriorityLabel(command: UnknownRecord): string {
  const source = command.manual || command.dynamic ? record(command.runtimeMetadata) : command
  const priority = normalizeCommandPriority(source.priority)
  if (priority === undefined) return "未知"
  const kind = source.priorityKind === "explicit" ? "代码显式配置" : source.priorityKind === "host-default" ? "宿主默认" : "运行态值"
  return `${priority}（${kind}）`
}

export function commandPriorityMetadata(command: UnknownRecord): UnknownRecord {
  const source = command.manual || command.dynamic ? record(command.runtimeMetadata) : command
  return { priority: normalizeCommandPriority(source.priority) ?? null, priorityLabel: commandPriorityLabel(command), priorityKind: source.priorityKind || "unknown", prioritySource: source.prioritySource || "unknown", pluginOrder: source.pluginOrder, ruleOrder: source.ruleOrder }
}

/** 已通过相关性与屏蔽筛选的指令按宿主调度顺序排列；缺失信息保留原相关性顺序。 */
export function compareCommandPriority(a: UnknownRecord, b: UnknownRecord): number {
  const left = commandPriorityMetadata(a), right = commandPriorityMetadata(b)
  if (left.priority == null) return right.priority == null ? 0 : 1
  if (right.priority == null) return -1
  if (Number(left.priority) < Number(right.priority)) return -1
  if (Number(left.priority) > Number(right.priority)) return 1
  const ordinal = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
  const pluginA = ordinal(left.pluginOrder), pluginB = ordinal(right.pluginOrder)
  if (pluginA === undefined) return pluginB === undefined ? 0 : 1
  if (pluginB === undefined) return -1
  if (pluginA !== pluginB) return pluginA - pluginB
  const ruleA = ordinal(left.ruleOrder), ruleB = ordinal(right.ruleOrder)
  if (ruleA === undefined) return ruleB === undefined ? 0 : 1
  return ruleB === undefined ? -1 : ruleA - ruleB
}

export interface CommandHelpDoc extends UnknownRecord {
  source?: unknown
  text?: unknown
}

export interface CommandParameterHint {
  name: string
  description: string
}

export interface CommandUsageGuide {
  heads: string[]
  parameters: CommandParameterHint[]
  intents: string[]
  confidence: "low" | "medium" | "manual" | "observed"
}

export interface CommandDocument extends UnknownRecord {
  helpDocs: CommandHelpDoc[]
  summary: string
  example: string
  suggestedCommand: string
  examples: string[]
  usageGuide: CommandUsageGuide
  commandHeads: string[]
  intentHints: string[]
  parameterHints: CommandParameterHint[]
  keywords: string[]
  searchText: string
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function safeText(value: unknown = ""): string {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function stripUrls(value: unknown = ""): string {
  return safeText(value)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/www\.\S+/gi, " ")
}

function commandConflictKey(command: UnknownRecord): string {
  // 完整示例优先，不能用 safeText 折叠内部空白后误合并两个发送文本。
  return typeof command.suggestedCommand === "string" ? command.suggestedCommand.trim() : preferredCommandText(command)
}

/** 保持不同指令的相关性位置，仅对相同推荐指令的实现应用调度优先级。 */
export function orderEquivalentCommandMatches<T>(rows: readonly T[], command: (row: T) => UnknownRecord = row => row as UnknownRecord): T[] {
  const key = (row: T): string => commandConflictKey(command(row))
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const name = key(row)
    if (name) groups.set(name, [...(groups.get(name) || []), row])
  }
  if (![...groups.values()].some(group => group.length > 1)) return [...rows]
  for (const group of groups.values()) if (group.length > 1) group.sort((a, b) => compareCommandPriority(command(a), command(b)))
  const offsets = new Map<string, number>()
  return rows.map(row => {
    const name = key(row)
    if (!name) return row
    const index = offsets.get(name) || 0
    offsets.set(name, index + 1)
    return groups.get(name)![index]
  })
}

export function tokenize(value: unknown = ""): string[] {
  const text = safeText(value).toLowerCase()
  const words = text.match(/[#/*]?[a-z0-9_\-\u4e00-\u9fa5]{2,}/gi) || []
  const tokens: string[] = []
  for (const word of words.map(item => item.toLowerCase())) {
    tokens.push(word)
    if (/[\u4e00-\u9fa5]/.test(word) && word.length > 2) {
      for (let index = 0; index < word.length - 1; index += 1) tokens.push(word.slice(index, index + 2))
    }
  }
  return [...new Set(tokens.filter(word => !["function", "async", "return", "true", "false"].includes(word)))].slice(0, 120)
}

const queryNoisePatterns = [
  /^(请问一下|请问|问下|想问下|想问|我想问下|我想问|帮我查下|帮我查|帮我看看|帮我看|帮我)/,
  /^(怎么查询|怎么查|怎么用|怎么弄|怎么)/,
  /^(如何查询|如何查|如何使用|如何用|如何设置|如何)/,
  /^(查一下|看一下|搜一下|搜一搜|查查|看看)/,
  /^(想知道|想了解|想看|想查|查看)(一下)?/,
]

export function normalizeSearchQuery(value: unknown = ""): string {
  let text = safeText(value).toLowerCase()
  for (const pattern of queryNoisePatterns) text = text.replace(pattern, "")
  if (!/^[#/*!]/u.test(text)) text = text.replace(/还剩多少|还有多少|剩余多少|剩下多少|还剩|剩余/gu, " ").replace(/\s+/gu, " ")
  text = text.replace(/[？?吗呢呀吧啊]+$/g, "")
  return safeText(text)
}

/** 面向检索的自然语言投影；运行规则和自动猜测参数仍留在元数据中供核对。 */
export function buildCommandRetrievalText(command: UnknownRecord): string {
  if (typeof command.retrievalText === "string") return cleanCommandRetrievalText(command.retrievalText, command)
  const examples = [...new Set([command.suggestedCommand, command.example, ...values(command.examples)].map(safeText).filter(Boolean))].filter(example => {
    if (example.length > 300 || !isValidCommandText(example)) return false
    if (!command.regexp) return true
    try { return boundedCommandMatch(command.regexp, example, true, safeText(command.regexpFlags)) } catch {
      // 无法安全核验的规则不提供索引示例；原始规则与候选示例仍保留供维护者核对。
      return false
    }
  }).slice(0, 8)
  const generic = new Set(["查询", "帮助", "设置", "管理", "指令", "功能", "使用"])
  const intents = values(command.intentHints).map(safeText).filter(value => value && !generic.has(value))
  const inferred = parameterHintsFromRegexp(command.regexp)
  const parameters = command.manual ? values(command.parameterHints).map(record).filter(item => item.name && item.description && !inferred.some(auto => auto.name === item.name && auto.description === item.description)) : []
  const parts = [
    command.description || command.summary ? `用途：${safeText(command.description || command.summary)}` : "",
    command.body ? `使用说明：${safeText(command.body)}` : "",
    intents.length ? `常见问法：${[...new Set(intents)].join("；")}` : "",
    parameters.length ? `参数：${parameters.map(item => `${safeText(item.name)}：${safeText(item.description)}`).join("；")}` : "",
    examples.length ? `示例指令：\n${examples.join("\n")}` : "",
  ]
  return parts.filter(Boolean).join("\n\n")
}

function isValidCommandText(value: unknown = ""): boolean {
  const text = safeText(value)
  if (!text) return false
  if (/^[.:]+$/.test(text)) return false
  if (/^<[^>]+>$/.test(text)) return false
  if (/^(内容|参数|数字)$/i.test(text)) return false
  if (commandHead(text, ["#", "/", "*", "!"])) return true
  return /^[#/*!][a-z0-9_\-\u4e00-\u9fa5]{1,32}$/i.test(text)
}

export function preferredCommandText(command: UnknownRecord = {}): string {
  const usageGuide = record(command.usageGuide)
  const candidates = [
    command.suggestedCommand,
    command.example,
    ...values(command.examples),
    ...values(command.commandHeads),
    ...values(usageGuide.heads),
  ]
  return candidates.map(item => safeText(item)).find(isValidCommandText) || ""
}

export function normalizedIdentityPart(value: unknown = ""): string {
  return safeText(value).toLowerCase()
}

export function commandIdentity(command: UnknownRecord = {}): string {
  const plugin = normalizedIdentityPart(command.pluginName || command.pluginKey || "unknown")
  const commandText = normalizedIdentityPart(preferredCommandText(command) || command.suggestedCommand || command.regexp || command.fnc)
  return `${plugin}::${commandText}`
}

export function commandHeadsFromText(value: unknown = ""): string[] {
  const matches = stripUrls(value).match(/[#!/*][a-zA-Z0-9_\-\u4e00-\u9fa5]{1,32}/g) || []
  return [...new Set(matches.map(item => item.trim()).filter(isValidCommandText))].slice(0, 12)
}

function extractRegexLiterals(source: unknown = ""): string[] {
  const cleaned = safeText(source)
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\([#/*])/g, "$1")
  const heads = commandHeadsFromText(cleaned)
  if (heads.length) return heads
  const prefix = cleaned.match(/^([#/*][^()[\]|?+*{\\\s]{1,32})/)
  return prefix?.[1] ? [prefix[1]] : []
}

function containsCommandHead(value: unknown = "", head: unknown = ""): boolean {
  const text = safeText(value).toLowerCase()
  const pattern = safeText(head).toLowerCase()
  if (!text || !pattern) return false
  let offset = 0
  while (offset <= text.length) {
    const index = text.indexOf(pattern, offset)
    if (index < 0) return false
    const before = text[index - 1]
    const after = text[index + pattern.length]
    if ((!before || !/[a-z0-9_\-\u4e00-\u9fa5]/i.test(before)) && (!after || !/[a-z0-9_\-\u4e00-\u9fa5]/i.test(after))) return true
    offset = index + pattern.length
  }
  return false
}

function helpDocsForCommand(helpDocs: unknown = [], regexp: unknown = ""): CommandHelpDoc[] {
  // 插件 README 是共享说明，只保留包含当前规则触发头的片段，避免跨指令串入。
  const heads = extractRegexLiterals(regexp)
  if (!heads.length || !Array.isArray(helpDocs)) return []
  const patterns = heads.map(item => safeText(item).toLowerCase()).filter(Boolean)
  return records(helpDocs).map(doc => {
    const lines = safeText(doc.text).split(/\r?\n/)
    const relevant = lines.filter(line => patterns.some(pattern => containsCommandHead(line, pattern)))
    if (!relevant.length) return null
    return { ...doc, text: relevant.join("\n").slice(0, 2000) }
  }).filter((value): value is CommandHelpDoc & { text: string } => value !== null)
}

function commandHeadsFromDocs(value: unknown = "", regexp: unknown = ""): string[] {
  const patterns = extractRegexLiterals(regexp).map(item => safeText(item).toLowerCase()).filter(Boolean)
  if (!patterns.length) return []
  return commandHeadsFromText(value).filter(item => patterns.some(pattern => containsCommandHead(item, pattern)))
}

function commandExamplesFromDocs(helpDocs: CommandHelpDoc[] = [], allowedHeads: string[] = []): string[] {
  const text = stripUrls(helpDocs.map(doc => safeText(doc.text)).join(" "))
  const matches = text.match(/[#!/*][a-zA-Z0-9_\-\u4e00-\u9fa5][^，。；;、\s`"'<>]{0,40}/g) || []
  const cleaned = matches.map(item => item.replace(/[)\]}]+$/, ""))
  const patterns = allowedHeads.map(item => safeText(item).toLowerCase()).filter(Boolean)
  return [...new Set(cleaned
    .filter(isValidCommandText)
    .filter(item => !patterns.length || patterns.some(pattern => containsCommandHead(item, pattern))))].slice(0, 8)
}

export function parameterHintsFromRegexp(source: unknown = ""): CommandParameterHint[] {
  const hints: CommandParameterHint[] = []
  const input = safeText(source)
  const add = (name: string, description: string): void => {
    if (!hints.some(item => item.name === name)) hints.push({ name, description })
  }
  if (/\\d|\[0-9]|\d/.test(input)) add("数字", "需要输入数字，例如页码、数量、群号或 QQ。")
  if (/\[\\s\\S\]|\.\*|\.\+/.test(input)) add("内容", "需要输入后续文本内容。")
  if (/\\s\+|\\s\*/.test(input)) add("空格", "指令和参数之间可以包含空格。")
  if (/\((?:\?:)?[^()|]+\|[^()]+\)/.test(input)) add("选项", "存在多种触发词或模式选项。")
  if (/@|at/i.test(input)) add("@用户", "可能需要 @ 指定用户。")
  return hints.slice(0, 8)
}

export function intentHintsFromText(value: unknown = ""): string[] {
  const lower = safeText(value).toLowerCase()
  const groups = [
    { intent: "查询", words: ["查", "查询", "状态", "信息", "面板", "列表", "排行", "记录", "日志", "统计", "info", "list", "status"] },
    { intent: "设置", words: ["设置", "配置", "开启", "关闭", "启用", "禁用", "修改", "绑定", "解绑", "set", "config"] },
    { intent: "管理", words: ["踢", "禁言", "撤回", "管理", "权限", "群", "审批", "拉黑", "白名单", "mute", "kick"] },
    { intent: "生成", words: ["生成", "绘图", "图片", "渲染", "合成", "转换", "导出", "draw", "render"] },
    { intent: "帮助", words: ["帮助", "help", "说明", "菜单", "指令"] },
    { intent: "娱乐", words: ["抽", "签到", "骰", "猜", "游戏", "点歌", "表情", "随机"] },
  ]
  return groups
    .filter(group => group.words.some(word => lower.includes(word.toLowerCase())))
    .map(group => group.intent)
    .slice(0, 6)
}

function buildUsageGuide(row: UnknownRecord = {}, example = ""): CommandUsageGuide {
  const parameters = parameterHintsFromRegexp(row.regexp)
  const helpDocs = helpDocsForCommand(row.helpDocs, row.regexp)
  const helpText = helpDocs.map(doc => safeText(doc.text)).join(" ")
  const heads = [...new Set([
    ...extractRegexLiterals(row.regexp),
    ...commandHeadsFromText(example),
    ...commandHeadsFromDocs(helpText, row.regexp),
  ])].slice(0, 12)
  const intents = intentHintsFromText([
    row.pluginName,
    row.description,
    row.fnc,
    row.regexp,
    example,
    helpText,
  ].map(safeText).join(" "))
  const confidence = row.regexp
    ? parameters.length || heads.length ? "medium" : "low"
    : "low"
  return { heads, parameters, intents, confidence }
}

export function buildCommandDoc(row: UnknownRecord = {}): CommandDocument {
  const helpDocs = helpDocsForCommand(row.helpDocs, row.regexp)
  const helpText = helpDocs.map(doc => safeText(doc.text)).join(" ")
  const regexHeads = extractRegexLiterals(row.regexp)
  const docExamples = commandExamplesFromDocs(helpDocs, regexHeads)
  const supplied = [row.suggestedCommand, row.example, ...values(row.examples), ...docExamples]
  const verified = row.regexp
    ? validatedCommandExamples(row.regexp, supplied, safeText(row.regexpFlags))
    : supplied.map(safeText).filter(isValidCommandText)
  const examples = [...new Set([...verified, ...commandExamplesFromRegexp(row.regexp, safeText(row.regexpFlags))])].slice(0, 8)
  const example = examples[0] || ""
  const commandHeads = [...new Set([
    ...regexHeads,
    ...commandHeadsFromText(example),
    ...commandHeadsFromDocs(helpText, row.regexp),
  ])].slice(0, 12)
  const suggestedCommand = example
  const usageGuide = buildUsageGuide({ ...row, helpDocs }, suggestedCommand)
  const searchText = safeText([
    row.pluginKey,
    row.pluginName,
    row.description,
    row.body,
    row.fnc,
    row.regexp,
    example,
    suggestedCommand,
    commandHeads.join(" "),
    usageGuide.intents.join(" "),
    usageGuide.parameters.map(item => `${item.name} ${item.description || ""}`).join(" "),
    row.permission,
    row.event,
    docExamples.join(" "),
  ].map(safeText).join(" "))
  return {
    ...row,
    helpDocs,
    summary: safeText(`${safeText(row.pluginName || row.pluginKey)} ${safeText(row.description || row.fnc)} ${suggestedCommand ? `建议指令：${suggestedCommand}` : ""}`),
    example,
    suggestedCommand,
    examples,
    usageGuide,
    commandHeads: commandHeads.length ? commandHeads : usageGuide.heads,
    intentHints: usageGuide.intents,
    parameterHints: usageGuide.parameters,
    keywords: tokenize(searchText),
    searchText,
  }
}

/** 已采集运行信息的只读快照；旧人工条目缺失字段不能当作真实运行值。 */
export function commandOriginalMetadata(source: UnknownRecord = {}): UnknownRecord {
  if (source.originalMetadata) return record(source.originalMetadata)
  // 旧覆盖层没有原文时不把补全文字冒充为采集原文；重扫时从来源恢复。
  const original = source.manual && source.overridesCommandId ? record(source.runtimeMetadata) : source
  return Object.fromEntries(["pluginKey", "pluginName", "description", "body", "suggestedCommand", "examples", "parameterHints", "fnc", "regexp", "regexpFlags", "permission", "event", "origin", "sourceRuleKey"].filter(key => original[key] !== undefined).map(key => [key, original[key]]))
}

export function commandRuntimeMetadata(source?: UnknownRecord): unknown {
  if (!source) return null
  const snapshot = source.runtimeMetadata ? record(source.runtimeMetadata) : {
    pluginKey: source.pluginKey,
    pluginName: source.pluginName,
    permission: source.manual ? null : source.permission,
    event: source.manual ? null : source.event,
    regexp: source.manual ? null : source.regexp,
    regexpFlags: source.regexpFlags || "",
    method: record(source.origin).method || (source.manual ? "" : source.fnc),
    origin: source.origin || null,
    sourceRuleKey: source.sourceRuleKey || source.overridesSourceRuleKey || "",
    capturedAt: source.updatedAt || "",
  }
  return { ...snapshot, ...commandPriorityMetadata(source) }
}

/** 人工说明覆盖只继承服务端来源，编辑内容不能替换实际运行规则。 */
export function preserveCommandSource(input: UnknownRecord, source: UnknownRecord | undefined, sourceId: string): UnknownRecord {
  return {
    ...input,
    sourceCommandId: sourceId,
    sourceRuleKey: source?.overridesSourceRuleKey || source?.sourceRuleKey || "",
    sourceOrigin: source?.origin || undefined,
    ...(sourceId ? {
      pluginKey: source?.pluginKey,
      pluginName: source?.pluginName,
      priority: source?.priority,
      permission: source?.permission,
      event: source?.event,
      fnc: source?.fnc,
      regexp: source?.regexp,
      regexpFlags: source?.regexpFlags || "",
    } : {}),
  }
}

/** 保持不同指令的相对位置，每个冲突组最多展示两个实现。 */
export function collapseEquivalentCommandMatches<T>(rows: readonly T[], command: (row: T) => UnknownRecord = row => row as UnknownRecord): T[] {
  const counts = new Map<string, number>()
  return rows.filter(row => {
    const name = commandConflictKey(command(row))
    if (!name) return true
    const count = (counts.get(name) || 0) + 1
    counts.set(name, count)
    return count <= 2
  })
}
