import { commandHead } from "../core/message/command-prefixes.js"

export type UnknownRecord = Record<string, unknown>

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
]

export function normalizeSearchQuery(value: unknown = ""): string {
  let text = safeText(value).toLowerCase()
  for (const pattern of queryNoisePatterns) text = text.replace(pattern, "")
  text = text.replace(/[？?吗呢呀吧啊]+$/g, "")
  return safeText(text)
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

function firstAlternative(group: unknown = ""): string {
  return safeText(group).split("|").map(item => item.trim()).filter(Boolean)[0] || ""
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

function regexpToCommandExample(source: unknown = ""): string {
  let text = safeText(source)
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\\//g, "/")
    .replace(/\\#/g, "#")
    .replace(/\\\*/g, "*")
  text = text.replace(/\(\?:([^()]+)\)\?/g, "")
  text = text.replace(/\(([^()[\]]+\|[^()[\]]+)\)\?/g, "")
  text = text.replace(/\(\?:([^()]+)\)/g, (_match, group: string) => firstAlternative(group))
  text = text.replace(/\(([^()[\]]+\|[^()[\]]+)\)/g, (_match, group: string) => firstAlternative(group))
  text = text.replace(/\(\\d\+\)|\(\[0-9][^)]*\)|\\d\+|\[0-9][^\]]*]/g, " <数字>")
  text = text.replace(/\(\[\\s\\S]\*\)|\(\.\*\)|\(\.\+\)|\(\[\\s\\S]\+\)|\[[^\]]*]\*|\[[^\]]*]\+/g, " <内容>")
  text = text.replace(/\\s\+|\\s\*/g, " ")
  text = text.replace(/\\([#/*?+.^$()[\]{}|\\])/g, "$1")
  text = text.replace(/[?+*{}]/g, "")
  text = text.replace(/\[[^\]]+]/g, "")
  text = text.replace(/[()|]/g, "")
  return safeText(text).slice(0, 120)
}

function readableRegexp(source: unknown = ""): string {
  const example = regexpToCommandExample(source)
  if (example) return example
  return safeText(source)
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\(\?:/g, "(")
    .replace(/\[[^\]]+]/g, "")
    .replace(/[\\^$+?.()[\]{}|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
}

export function buildCommandDoc(row: UnknownRecord = {}): CommandDocument {
  const helpDocs = helpDocsForCommand(row.helpDocs, row.regexp)
  const helpText = helpDocs.map(doc => safeText(doc.text)).join(" ")
  const regexHeads = extractRegexLiterals(row.regexp)
  const docExamples = commandExamplesFromDocs(helpDocs, regexHeads)
  const example = readableRegexp(row.regexp)
  const commandHeads = [...new Set([
    ...regexHeads,
    ...commandHeadsFromText(example),
    ...commandHeadsFromDocs(helpText, row.regexp),
  ])].slice(0, 12)
  const suggestedCommand = preferredCommandText({
    suggestedCommand: example,
    examples: docExamples,
    commandHeads,
  }) || ""
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
    examples: [...new Set([suggestedCommand, ...docExamples].filter(Boolean))].slice(0, 8),
    usageGuide,
    commandHeads: commandHeads.length ? commandHeads : usageGuide.heads,
    intentHints: usageGuide.intents,
    parameterHints: usageGuide.parameters,
    keywords: tokenize(searchText),
    searchText,
  }
}
