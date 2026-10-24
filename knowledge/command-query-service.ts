import { evaluateCommandCompleteness, type CommandCompleteness } from "./command-completeness.js"
import { commandHead } from "../core/message/command-prefixes.js"
import {
  normalizeSearchQuery,
  preferredCommandText,
  safeText,
  tokenize,
  commandPriorityMetadata,
  orderEquivalentCommandMatches,
  buildCommandRetrievalText,
} from "./command-document-builder.js"

type UnknownRecord = Record<string, unknown>
type Command = UnknownRecord
type CountMap = Record<string, number>

interface QueryOptions extends UnknownRecord {
  limit?: unknown
  commandPrefixes?: unknown
  usageCounts?: unknown
  score?: unknown
  reason?: unknown
  matchedTokens?: unknown
  stats?: unknown
  observer?: unknown
  prioritizeCommands?: boolean
  minRelevance?: unknown
  capture?: unknown
}

interface QualityRow extends Command, CommandCompleteness {
  issues: string[]
  qualityScore: number
  usageCount: number
  completenessStatus: "complete" | "incomplete" | "needs-review"
}

export { COMMAND_COMPLETENESS_ISSUE_LABELS } from "./command-completeness.js"

interface PluginQualitySummary {
  pluginName: string
  commands: number
  issueCommands: number
  issues: CountMap
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

function strings(value: unknown): string[] {
  return values(value).map(item => safeText(item)).filter(Boolean)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function commandGuide(command: Command): UnknownRecord {
  return record(command.usageGuide)
}

function commandHeads(command: Command): string[] {
  return strings(command.commandHeads || commandGuide(command).heads)
}

function commandIntents(command: Command): string[] {
  return strings(command.intentHints || commandGuide(command).intents)
}

function commandParameters(command: Command): UnknownRecord[] {
  return records(command.parameterHints || commandGuide(command).parameters)
}

function commandExamples(command: Command): string[] {
  return strings(command.examples)
}

function countBy(items: readonly Command[], pick: (item: Command) => unknown): CountMap {
  const counts: CountMap = {}
  for (const item of items) {
    const key = text(pick(item)) || "unknown"
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function countValues(items: readonly unknown[]): CountMap {
  const counts: CountMap = {}
  for (const item of items) {
    const key = text(item) || "unknown"
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function topCounts(counts: CountMap = {}, limit = 12): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

function commandSection(command: Command): { key: string; label: string; rank: number } {
  const textValue = safeText([
    command.pluginKey,
    command.pluginName,
    command.description,
    command.summary,
    command.fnc,
    command.suggestedCommand,
    command.example,
    ...commandExamples(command),
    ...commandHeads(command),
    ...commandIntents(command),
  ].map(text).join(" ")).toLowerCase()
  const hasAny = (words: readonly string[]) => words.some(word => textValue.includes(word.toLowerCase()))
  if (hasAny(["#yui", "#yuichat", "#yuihelp", "yui chat", "ai面板", "人格", "mcp", "skill", "渲染", "工具调用", "对话", "智能体", "openai", "claude", "gemini"])) {
    return { key: "ai", label: "AI 相关", rank: 0 }
  }
  if (hasAny(["体力", "原神", "绝区零", "星铁", "米游社", "角色", "深渊", "uid", "绑定", "cookie", "攻略", "抽卡", "签到", "战绩"])) {
    return { key: "game", label: "游戏查询与绑定", rank: 1 }
  }
  if (hasAny(["群管", "禁言", "撤回", "踢", "审批", "权限", "设置主人", "管理员", "白名单", "黑名单"])) {
    return { key: "group-admin", label: "群管与配置", rank: 2 }
  }
  if (hasAny(["戳一戳", "戳", "表情", "meme", "互动", "娱乐", "随机", "poke"])) {
    return { key: "other-fun", label: "其他互动", rank: 9 }
  }
  return { key: "other", label: "其他功能", rank: 8 }
}

function commandView(command: Command): Command {
  const section = commandSection(command)
  return {
    id: command.id,
    sourceId: command.sourceId,
    pluginKey: command.pluginKey,
    pluginName: command.pluginName,
    description: command.description,
    summary: command.summary,
    fnc: command.fnc,
    regexp: command.regexp,
    regexpFlags: command.regexpFlags || "",
    suggestedCommand: command.suggestedCommand,
    examples: commandExamples(command),
    commandHeads: commandHeads(command),
    intentHints: commandIntents(command),
    parameterHints: commandParameters(command),
    usageGuide: command.usageGuide,
    permission: command.permission,
    event: command.event,
    ...commandPriorityMetadata(command),
    origin: command.origin,
    runtimeMetadata: command.runtimeMetadata,
    sourceRuleKey: command.sourceRuleKey,
    sourceStatus: command.sourceStatus,
    needsReview: command.needsReview,
    dynamic: Boolean(command.dynamic || command.pluginKey === "observed"),
    manual: Boolean(command.manual || command.pluginKey === "manual"),
    observed: command.observed,
    usageCount: numberValue(command.usageCount, 0),
    sectionKey: section.key,
    sectionLabel: section.label,
    sectionRank: section.rank,
    updatedAt: command.updatedAt,
  }
}

function confidenceForCommand(command: Command): "manual" | "observed" | "high" | "medium" | "low" {
  const score = numberValue(command.score, 0)
  if (command.manual || command.pluginKey === "manual") return "manual"
  if (command.dynamic || command.pluginKey === "observed") return "observed"
  if (score >= 24 || numberValue(command.usageCount, 0) >= 3) return "high"
  if (score >= 10 || values(command.matchedTokens).length || commandHeads(command).length) return "medium"
  return "low"
}

function nextStepsForCommand(command: Command): string[] {
  const steps: string[] = []
  const suggested = text(command.suggestedCommand || command.example)
  const parameters = commandParameters(command)
  if (suggested) steps.push(`可先尝试：${suggested}`)
  if (parameters.length) steps.push(`补齐参数：${parameters.map(item => text(item.name)).join("、")}`)
  if (command.permission && command.permission !== "all") steps.push(`注意权限：${text(command.permission)}`)
  if (command.dynamic || command.pluginKey === "observed") steps.push("这是动态观察到的指令，建议管理员补充静态说明。")
  return steps.slice(0, 5)
}

function explainCommandRecommendation(command: Command, query: unknown = ""): Command {
  const executableCommand = preferredCommandText(command)
  const matchedSignals = [
    ...values(command.matchedTokens).map(token => `关键词 ${text(token)}`),
    ...commandIntents(command).slice(0, 3).map(intent => `意图 ${intent}`),
    ...commandHeads(command).slice(0, 3).map(head => `触发头 ${head}`),
  ]
  if (command.usageCount) matchedSignals.push(`近期触发 ${text(command.usageCount)} 次`)
  const reason = text(command.reason) || (matchedSignals.length ? `匹配${matchedSignals.slice(0, 3).join("、")}` : "匹配插件规则或帮助文档")
  return {
    query: safeText(query),
    command: executableCommand,
    reason,
    confidence: confidenceForCommand(command),
    score: numberValue(command.score, 0),
    matchedSignals: [...new Set(matchedSignals)].slice(0, 10),
    nextSteps: nextStepsForCommand(command),
    parameterHints: commandParameters(command),
    examples: commandExamples(command).length ? commandExamples(command) : strings([command.example]),
  }
}

export function buildCommandRecommendationResult(command: Command = {}, query: unknown = "", opts: QueryOptions = {}): Command {
  const score = numberValue(opts.score ?? command.score, 0)
  const reason = text(opts.reason || command.reason).trim()
  const matchedTokens = values(opts.matchedTokens || command.matchedTokens)
  const item: Command = {
    ...command,
    score,
    reason,
    matchedTokens,
    suggestedCommand: command.suggestedCommand || command.example || preferredCommandText(command),
  }
  return {
    ...commandView(item),
    body: item.body,
    retrievalText: buildCommandRetrievalText(item),
    lexicalScore: item.lexicalScore,
    lexicalRelevance: item.lexicalRelevance,
    exactCommandMatch: item.exactCommandMatch === true,
    keywords: values(item.keywords),
    matchedTokens: item.matchedTokens,
    score,
    reason: reason || "匹配插件规则或帮助文档",
    recommendation: explainCommandRecommendation(item, query),
  }
}

function usageCount(usageCounts: unknown, id: unknown): number {
  if (usageCounts instanceof Map) return numberValue(usageCounts.get(id) ?? usageCounts.get(text(id)), 0)
  return numberValue(record(usageCounts)[text(id)], 0)
}

export function buildCommandCaptureDigest(events: readonly Command[] = [], limit = 20): UnknownRecord {
  const byMatchType = countBy(events, item => item.matchType || (values(item.exactMatches).length ? "exact" : item.observedCommandId ? "observed" : values(item.matches).length ? "fuzzy" : "unmatched"))
  const byPrefix = countBy(events, item => item.commandPrefix || text(commandHead(item.text)).slice(0, 1) || "unknown")
  const withHandler = events.filter(item => item.handledBy).length
  const withExact = events.filter(item => values(item.exactMatches).length).length
  const observed = events.filter(item => item.observedCommandId).length
  return {
    total: events.length,
    withHandler,
    withExact,
    observed,
    exactCoverageRatio: events.length ? Number((withExact / events.length).toFixed(4)) : 0,
    handlerCoverageRatio: events.length ? Number((withHandler / events.length).toFixed(4)) : 0,
    observedRatio: events.length ? Number((observed / events.length).toFixed(4)) : 0,
    byMatchType: topCounts(byMatchType, limit),
    byPrefix: topCounts(byPrefix, limit),
  }
}

export function findCommandMatches(commands: readonly Command[] = [], query: unknown = "", opts: QueryOptions = {}): Command[] {
  const limit = Math.max(1, Math.min(100, numberValue(opts.limit, 10) || 10))
  const rawText = safeText(query).toLowerCase()
  const searchText = normalizeSearchQuery(rawText) || rawText
  const queryHead = commandHead(rawText, opts.commandPrefixes || [])
  const tokens = tokenize(searchText)
  const meaningfulTokens = tokens.filter(token => !["查询", "指令", "命令", "功能", "使用", "方法"].includes(token))
  const coverageTokens = meaningfulTokens.length ? meaningfulTokens : tokens
  const threshold = Math.max(0, Math.min(1, numberValue(opts.minRelevance, 0.55)))
  const commandName = (value: unknown): string => safeText(value).toLowerCase().replace(/^[#/*!]+/u, "").trim()
  const queryName = commandName(searchText)
  const scored: Command[] = commands.map<Command>(command => {
    const guide = commandGuide(command)
    const indexed = typeof command.retrievalText === "string"
    const indexedText = indexed ? safeText(command.retrievalText).toLowerCase() : ""
    const heads = commandHeads(command).filter(head => !indexed || indexedText.includes(head.toLowerCase()))
    const exactCommandMatch = queryName.length >= 2 && [...heads, command.suggestedCommand, ...commandExamples(command)].some(head => (!indexed || indexedText.includes(safeText(head).toLowerCase())) && commandName(head) === queryName)
    const intents = commandIntents(command).filter(intent => !indexed || indexedText.includes(intent.toLowerCase()))
    const parameters = commandParameters(command)
    const haystack = indexed ? indexedText : safeText([
      command.pluginName,
      command.description,
      command.retrievalText,
      command.summary,
      command.fnc,
      command.regexp,
      command.permission,
      command.example,
      command.suggestedCommand,
      ...commandExamples(command),
      ...heads,
      ...intents,
      ...parameters.map(item => `${text(item.name)} ${text(item.description)}`),
    ].map(text).join(" ")).toLowerCase()
    const keywordSet = new Set(tokenize(haystack))
    let score = 0
    let lexicalScore = 0
    const matchedTokens: string[] = []
    for (const token of tokens) {
      let matched = false
      if (haystack.includes(token)) {
        score += token.length
        lexicalScore += token.length
        matched = true
      }
      if (keywordSet.has(token)) {
        score += token.length
        lexicalScore += token.length
        matched = true
      }
      if (heads.some(head => head.toLowerCase().includes(token))) {
        score += token.length + 2
        lexicalScore += token.length + 2
        matched = true
      }
      if (intents.some(intent => intent.toLowerCase().includes(token))) {
        score += token.length + 1
        lexicalScore += token.length + 1
        matched = true
      }
      if (matched) matchedTokens.push(token)
    }
    if (queryHead && heads.includes(queryHead)) {
      score += 18
      lexicalScore += 18
    }
    if (!indexed && searchText && text(command.regexp).includes(searchText.replace(/^#/, ""))) {
      score += 8
      lexicalScore += 8
    }
    if ((!indexed || indexedText.includes(searchText)) && command.suggestedCommand && searchText && text(command.suggestedCommand).toLowerCase().includes(searchText.replace(/^#/, ""))) {
      score += 12
      lexicalScore += 12
    }
    if (!indexed && text(command.description).toLowerCase().includes(searchText) && searchText.length >= 2) {
      score += 8
      lexicalScore += 8
    }
    const recentUsage = usageCount(opts.usageCounts, command.id)
    score += Math.min(8, recentUsage)
    if (!preferredCommandText(command)) score -= 6
    const hasQueryMatch = lexicalScore > 0 || Boolean(queryHead && heads.includes(queryHead))
    const lexicalRelevance = (queryHead && heads.includes(queryHead)) || (searchText.length >= 2 && haystack.includes(searchText))
      ? 1
      : coverageTokens.length ? coverageTokens.filter(token => matchedTokens.includes(token)).length / coverageTokens.length : hasQueryMatch ? 1 : 0
    const reason = matchedTokens.length
      ? `匹配关键词：${[...new Set(matchedTokens)].slice(0, 6).join("、")}`
      : recentUsage
        ? `该指令近期触发过 ${recentUsage} 次`
        : "匹配插件规则或帮助文档"
    return {
      ...command,
      usageCount: recentUsage,
      score,
      lexicalScore,
      lexicalRelevance,
      exactCommandMatch,
      executableCommand: preferredCommandText(command),
      hasQueryMatch,
      matchedTokens: [...new Set(matchedTokens)].slice(0, 12),
      reason,
      usageGuide: guide,
    }
  })
  const matched = scored
    .filter(command => command.hasQueryMatch && numberValue(command.lexicalRelevance) >= threshold && numberValue(command.score) > 0 && command.executableCommand)
    .sort((a, b) => numberValue(b.lexicalScore) - numberValue(a.lexicalScore) || numberValue(b.score) - numberValue(a.score) || text(a.id).localeCompare(text(b.id)))
  return (opts.prioritizeCommands !== false ? orderEquivalentCommandMatches(matched) : matched)
    .slice(0, limit)
    .map(command => ({
      ...command,
      suggestedCommand: command.executableCommand || command.suggestedCommand,
    }))
}

/** 先确定相关候选集，再应用宿主调度顺序；向量相近不等于已确认同一功能。 */
export function selectRelevantCommandCandidates(candidates: readonly Command[]): { results: Command[]; policy: string; filtered: number } {
  const exact = candidates.filter(item => item.exactCommandMatch === true)
  const covered = candidates.filter(item => numberValue(item.lexicalRelevance) === 1)
  const semantic = candidates.filter(item => typeof item.vectorSimilarity === "number" && Number.isFinite(item.vectorSimilarity))
  const best = Math.max(...semantic.map(item => Number(item.vectorSimilarity)))
  // 无充分词项证据且未经过模型核验时，只推荐距离最近的一组；容差仅处理 float32 舍入。
  const nearest = semantic.filter(item => best - Number(item.vectorSimilarity) <= 1e-6)
  const results = exact.length ? exact : covered.length ? covered : nearest.length ? nearest : [...candidates]
  return { results, policy: exact.length ? "exact-command" : covered.length ? "keyword-covered" : nearest.length ? "semantic-nearest" : "hybrid-candidates", filtered: candidates.length - results.length }
}

export function buildCommandRecommendations(commands: readonly Command[] = [], query: unknown = "", opts: QueryOptions = {}): UnknownRecord {
  const limit = Math.max(1, Math.min(20, numberValue(opts.limit, 5) || 5))
  const results = findCommandMatches(commands, query, { ...opts, limit }).map(command => buildCommandRecommendationResult(command, query))
  return {
    query: safeText(query),
    generatedAt: new Date().toISOString(),
    count: results.length,
    results,
    summary: results.length
      ? results.map((item, index) => `${index + 1}. ${text(record(item.recommendation).command || item.suggestedCommand || item.fnc)}：${text(record(item.recommendation).reason)}`).join("\n")
      : "没有找到匹配的指令。",
  }
}

export function buildCommandDigest(commands: readonly Command[] = [], events: readonly Command[] = [], opts: QueryOptions = {}): UnknownRecord {
  const limit = Math.max(1, Math.min(100, numberValue(opts.limit, 20) || 20))
  const commandsWithUsage: Command[] = commands.map<Command>(command => ({ ...command, usageCount: usageCount(opts.usageCounts, command.id) }))
  const dynamicCommands = commandsWithUsage.filter(item => item.dynamic || item.pluginKey === "observed")
  const manualCommands = commandsWithUsage.filter(item => item.manual || item.pluginKey === "manual")
  const commandsWithExamples = commandsWithUsage.filter(item => item.suggestedCommand || item.example || values(item.examples).length)
  const commandsWithHeads = commandsWithUsage.filter(item => commandHeads(item).length)
  const commandsWithParameterHints = commandsWithUsage.filter(item => commandParameters(item).length)
  const topUsed = commandsWithUsage
    .filter(item => numberValue(item.usageCount) > 0)
    .sort((a, b) => numberValue(b.usageCount) - numberValue(a.usageCount))
    .slice(0, limit)
    .map(commandView)
  return {
    generatedAt: new Date().toISOString(),
    stats: {
      ...record(opts.stats),
      dynamicCommands: dynamicCommands.length,
      manualCommands: manualCommands.length,
      commandsWithExamples: commandsWithExamples.length,
      commandsWithHeads: commandsWithHeads.length,
      commandsWithParameterHints: commandsWithParameterHints.length,
      exampleCoverageRatio: commandsWithUsage.length ? Number((commandsWithExamples.length / commandsWithUsage.length).toFixed(4)) : 0,
      commandHeadCoverageRatio: commandsWithUsage.length ? Number((commandsWithHeads.length / commandsWithUsage.length).toFixed(4)) : 0,
      parameterHintCoverageRatio: commandsWithUsage.length ? Number((commandsWithParameterHints.length / commandsWithUsage.length).toFixed(4)) : 0,
      uniquePermissions: new Set(commandsWithUsage.map(item => text(item.permission || "all"))).size,
      uniqueEvents: new Set(commandsWithUsage.map(item => text(item.event || "message"))).size,
    },
    observer: record(opts.observer),
    capture: record(opts.capture),
    distributions: {
      plugins: topCounts(countBy(commandsWithUsage, item => item.pluginName || item.pluginKey), limit),
      pluginKeys: topCounts(countBy(commandsWithUsage, item => item.pluginKey), limit),
      permissions: topCounts(countBy(commandsWithUsage, item => item.permission || "all"), limit),
      events: topCounts(countBy(commandsWithUsage, item => item.event || "message"), limit),
      intents: topCounts(countValues(commandsWithUsage.flatMap(item => commandIntents(item).length ? commandIntents(item) : ["unknown"])), limit),
      commandHeads: topCounts(countValues(commandsWithUsage.flatMap(item => commandHeads(item).length ? commandHeads(item) : ["unknown"])), limit),
      dynamicHandlers: topCounts(countBy(dynamicCommands, item => record(item.observed).handledBy || item.fnc || "observed"), limit),
    },
    topUsed,
    dynamicCommands: dynamicCommands
      .sort((a, b) => text(record(b.observed).lastSeenAt || b.updatedAt).localeCompare(text(record(a.observed).lastSeenAt || a.updatedAt)))
      .slice(0, limit)
      .map(commandView),
    recentEvents: [...events].slice(-limit).reverse(),
    sampleCommands: commandsWithUsage.slice(0, limit).map(commandView),
  }
}

export function commandQuality(command: Command, usageCounts: unknown = {}): QualityRow {
  const usage = usageCount(usageCounts, command.id)
  return { ...commandView({ ...command, usageCount: usage }), ...evaluateCommandCompleteness(command), usageCount: usage }
}

export function buildCommandQualityReport(commands: readonly Command[] = [], opts: QueryOptions = {}): UnknownRecord {
  const limit = Math.max(1, Math.min(100, numberValue(opts.limit, 30) || 30))
  const rows = commands.map(command => commandQuality(command, opts.usageCounts))
  const issueCounts = countValues(rows.flatMap(row => row.issues.length ? row.issues : ["ok"]))
  const byPluginMap = rows.reduce<Record<string, PluginQualitySummary>>((acc, row) => {
    const key = text(row.pluginName || row.pluginKey || "unknown")
    const current = acc[key] || { pluginName: key, commands: 0, issueCommands: 0, issues: {} }
    current.commands += 1
    if (row.issues.length) current.issueCommands += 1
    for (const issue of row.issues) current.issues[issue] = (current.issues[issue] || 0) + 1
    acc[key] = current
    return acc
  }, {})
  const byPlugin = Object.values(byPluginMap)
    .sort((a, b) => b.issueCommands - a.issueCommands || b.commands - a.commands)
    .slice(0, limit)
  const weakRows = rows
    .filter(row => row.issues.length)
    .sort((a, b) => a.qualityScore - b.qualityScore || text(a.id).localeCompare(text(b.id)))
    .slice(0, limit)
  const recommendations: string[] = []
  if (issueCounts["missing-command"]) recommendations.push("在 retrievalText 的“指令”行写明触发文本、带参模板或事件触发方式，避免函数名和正则碎片。")
  if (issueCounts["missing-purpose"] || issueCounts["pending-purpose"]) recommendations.push("在 retrievalText 的“用途”行说明具体功能，不用插件名称代替说明。")
  if (["missing-example", "example-invalid", "example-mismatch", "example-unverified"].some(code => issueCounts[code])) recommendations.push("在 retrievalText 的“示例”行提供具体示例值，注明已知的前置条件；格式完整不代表执行成功。")
  if (issueCounts["missing-parameters"] || issueCounts["pending-parameters"]) recommendations.push("在 retrievalText 的“参数”行说明参数；无需参数时明确写“无”，不必补充重复元数据。")
  if (issueCounts["pending-verification"]) recommendations.push("先核对正文中的待核实或待补充项，不要为提高完整度编造信息。")
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      scoreMeaning: "retrieval-text-completeness",
      ruleVersion: "command-completeness-v2",
      commands: rows.length,
      issueCommands: rows.filter(row => row.issues.length).length,
      okCommands: rows.filter(row => !row.issues.length).length,
      averageQualityScore: rows.length ? Number((rows.reduce((sum, row) => sum + row.qualityScore, 0) / rows.length).toFixed(2)) : 0,
      issues: issueCounts,
    },
    recommendations,
    byPlugin,
    weakCommands: weakRows,
  }
}
