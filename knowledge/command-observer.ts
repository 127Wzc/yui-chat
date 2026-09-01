import crypto from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { configStore, dataDir, yunzaiRoot } from "../config/store.js"
import { AtomicJsonRepository } from "../core/storage/atomic-json-repository.js"
import { commandHead, commandPrefixes, escapeRegExp, isCommandMessage } from "../core/message/command-prefixes.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import {
  buildCommandDoc,
  commandHeadsFromText,
  commandIdentity,
  intentHintsFromText,
  normalizedIdentityPart,
  parameterHintsFromRegexp,
  preferredCommandText,
  safeText,
  tokenize,
} from "./command-document-builder.js"
import type {
  CommandDocument,
  CommandParameterHint,
  UnknownRecord,
} from "./command-document-builder.js"
import type {
  CommandEvent,
  CommandObserverStats,
  CommandRecommendationResponse,
  CommandRecord,
  ManualCommandInput,
  ObserverOptions,
  PluginsLoaderApi,
} from "./command-observer.types.js"
import {
  buildCommandCaptureDigest,
  buildCommandDigest,
  buildCommandQualityReport,
  buildCommandRecommendations,
  findCommandMatches,
} from "./command-query-service.js"
import { commandIndexStorage, commandKind, compactCommandDoc } from "./command-storage.js"
import { resetCommandSourceLocator, runtimeRuleOrigin } from "./command-source-locator.js"
import { recommendCommandHybrid } from "./command-hybrid-retrieval.js"

// Yunzai 加载器是宿主框架边界；通过宿主根目录定位，避免生产产物目录改变相对路径。
const PluginsLoader = (await import(pathToFileURL(path.join(yunzaiRoot, "lib/plugins/loader.js")).href)).default

const pluginsLoader = PluginsLoader as PluginsLoaderApi

export { buildCommandDoc } from "./command-document-builder.js"

const eventsFile = path.join(dataDir, "command-kb", "events.json")

function arrayValue(value: CommandEvent[]): CommandEvent[] {
  if (!Array.isArray(value)) throw new Error("指令知识库文件必须是 JSON 数组")
  return value
}

const eventsRepository = new AtomicJsonRepository<CommandEvent[]>({
  file: eventsFile,
  defaultValue: [],
  normalize: arrayValue,
  onReadError(err) {
    hostRuntime.logger?.warn?.("[yui-chat] 指令事件读取失败，损坏文件已隔离并使用空记录", err)
  },
})

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function commandRecord(value: UnknownRecord): CommandRecord {
  return value as CommandRecord
}

function currentConfig(): UnknownRecord {
  return record(configStore.get())
}

function observerError(message: string, code: string): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode: 409 })
}

function serializeRegExp(reg: unknown): string {
  if (!reg) return ""
  if (reg instanceof RegExp) return reg.source
  return String(reg)
}

function isEphemeralInternalRule(regexp = "") {
  // 部分第三方插件用随机字符串注册内部消息钩子；它不是用户可输入的指令，
  // 每次进程启动都会变化，不能进入会触发向量重建的指令知识库。
  return /^sf-plugin-[a-z0-9_-]+-\d+$/i.test(String(regexp).trim())
}

function stripAnsi(value: unknown = ""): string {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "")
}

function regexpMatches(source = "", text = "") {
  if (!source || !text) return false
  try {
    return new RegExp(source).test(text)
  } catch {
    return false
  }
}

function observedId(head = "", handledBy = "") {
  const digest = crypto.createHash("sha1").update(`${head}\n${handledBy}`).digest("hex").slice(0, 16)
  return `observed:${digest}`
}

function observedPluginName(handledBy = "") {
  const cleaned = stripAnsi(handledBy)
  const bracket = cleaned.match(/\[([^\]]+)]/)
  if (bracket?.[1]) return bracket[1]
  return cleaned || "动态观察"
}

function mergeParameterHints(...groups: CommandParameterHint[][]): CommandParameterHint[] {
  const byName = new Map<string, CommandParameterHint>()
  for (const hints of groups) {
    for (const hint of hints || []) {
      if (!hint?.name || byName.has(hint.name)) continue
      byName.set(hint.name, {
        name: hint.name,
        description: hint.description || "",
      })
    }
  }
  return [...byName.values()].slice(0, 8)
}

function normalizeStringList(value: unknown = []): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean)
  return String(value || "").split(/[\n,，;；|]+/).map(item => item.trim()).filter(Boolean)
}

function normalizeParameterHints(value: unknown = []): CommandParameterHint[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === "string") return { name: item.trim(), description: "" }
      return { name: safeText(item?.name), description: safeText(item?.description) }
    }).filter(item => item.name).slice(0, 8)
  }
  return normalizeStringList(value).map(name => ({ name, description: "" })).slice(0, 8)
}

function buildManualCommandDoc(input: ManualCommandInput = {}): CommandDocument {
  const suggestedCommand = safeText(input.suggestedCommand || input.command || input.commandHead)
  const sourceCommandId = safeText(input.sourceCommandId)
  const sourceRuleKey = safeText(input.sourceRuleKey)
  const body = String(input.body || input.notes || "").trim().slice(0, 12000)
  const heads = [
    ...normalizeStringList(input.commandHeads),
    ...commandHeadsFromText(suggestedCommand),
  ].filter(Boolean)
  const head = heads[0] || commandHead(suggestedCommand, commandPrefixes(configStore.get()))
  const regexp = safeText(input.regexp) || (head ? `^${escapeRegExp(head)}([\\s\\S]*)$` : "")
  const examples = [...new Set([
    suggestedCommand,
    ...normalizeStringList(input.examples),
  ].filter(Boolean))].slice(0, 8)
  const pluginName = safeText(input.pluginName || input.pluginKey) || "手动知识"
  const seed = sourceRuleKey || sourceCommandId || `${normalizedIdentityPart(pluginName)}::${normalizedIdentityPart(suggestedCommand || regexp || input.fnc)}`
  const inputId = safeText(input.id)
  const id = inputId.startsWith("manual:") ? inputId : `manual:${crypto.createHash("sha1").update(seed || JSON.stringify(input)).digest("hex").slice(0, 16)}`
  const parameterHints = mergeParameterHints(
    normalizeParameterHints(input.parameterHints),
    parameterHintsFromRegexp(regexp),
    parameterHintsFromObservedText(suggestedCommand, head),
  )
  const requestedConfidence = String(input.confidence || "")
  const confidence = ["low", "medium", "manual", "observed"].includes(requestedConfidence)
    ? requestedConfidence as "low" | "medium" | "manual" | "observed"
    : "manual"
  const doc = buildCommandDoc({
    id,
    pluginKey: safeText(input.pluginKey) || "manual",
    pluginName,
    description: safeText(input.description || input.summary || "手动补充的指令说明"),
    body,
    fnc: safeText(input.fnc) || "manual_command",
    regexp,
    permission: safeText(input.permission) || "unknown",
    event: safeText(input.event) || "message",
    priority: Number(input.priority || 90000),
    origin: input.sourceOrigin && typeof input.sourceOrigin === "object" ? { ...input.sourceOrigin } : { type: "manual", label: "管理台手动补充", pluginKey: "manual", pluginName, file: "", fileRole: "无源码文件", method: "" },
    helpDocs: [{ source: "manual", text: safeText([input.description, body, examples.join(" ")].join(" ")).slice(0, 12000) }],
    updatedAt: new Date().toISOString(),
  })
  doc.manual = true
  doc.overridesCommandId = sourceCommandId
  doc.overridesSourceRuleKey = sourceRuleKey
  doc.suggestedCommand = suggestedCommand || doc.suggestedCommand
  doc.example = doc.suggestedCommand || doc.example
  doc.examples = examples.length ? examples : doc.examples
  doc.commandHeads = [...new Set([...heads, ...(doc.commandHeads || [])].filter(Boolean))].slice(0, 12)
  doc.intentHints = [...new Set([
    ...normalizeStringList(input.intentHints),
    ...(doc.intentHints || []),
    ...intentHintsFromText(`${input.description || ""} ${examples.join(" ")}`),
  ])].slice(0, 8)
  doc.parameterHints = parameterHints
  doc.usageGuide = {
    ...(doc.usageGuide || {}),
    heads: doc.commandHeads,
    intents: doc.intentHints,
    parameters: doc.parameterHints,
    confidence,
  }
  doc.searchText = safeText([
    doc.searchText,
    body,
    doc.commandHeads.join(" "),
    doc.parameterHints.map(item => `${item.name} ${item.description}`).join(" "),
  ].join(" "))
  doc.keywords = tokenize(doc.searchText)
  return doc
}

function buildObservedCommandDoc(event: CommandEvent = {}): CommandDocument | null {
  const head = event.commandHead || commandHead(event.text, event.commandPrefixes)
  if (!head) return null
  const handledBy = stripAnsi(event.handledBy || "")
  const pluginName = observedPluginName(handledBy)
  const doc = buildCommandDoc({
    id: observedId(head, handledBy),
    pluginKey: "observed",
    pluginName,
    description: "动态捕获到的真实触发指令",
    fnc: handledBy || "observed_command",
    regexp: `^${escapeRegExp(head)}([\\s\\S]*)$`,
    permission: "unknown",
    event: "message",
    priority: 99999,
    origin: {
      type: "observed",
      label: "动态观察",
      pluginKey: "observed",
      pluginName,
      file: "",
      fileRole: "运行日志",
      method: handledBy,
    },
    helpDocs: [{ source: "dynamic-events", text: `${event.text || head} ${handledBy}` }],
    suggestedCommand: head,
    examples: [head, event.text].filter((value): value is string => Boolean(value)),
    dynamic: true,
    observed: {
      head,
      firstSeenAt: event.time,
      lastSeenAt: event.time,
      count: 1,
      handledBy,
      samples: [event.text].filter((value): value is string => Boolean(value)).slice(0, 5),
      signatures: [event.signature || commandSignature(event.text, event.commandPrefixes)].filter((value): value is string => Boolean(value)).slice(0, 8),
    },
    updatedAt: event.time || new Date().toISOString(),
  })
  doc.suggestedCommand = head
  doc.example = head
  doc.examples = [...new Set([head, event.text].filter((value): value is string => Boolean(value)))].slice(0, 8)
  doc.commandHeads = [head]
  doc.intentHints = intentHintsFromText(`${event.text || ""} ${handledBy}`)
  doc.parameterHints = parameterHintsFromObservedText(event.text, head)
  doc.usageGuide = {
    ...(doc.usageGuide || {}),
    heads: doc.commandHeads,
    intents: doc.intentHints,
    parameters: doc.parameterHints,
    confidence: "observed",
  }
  return doc
}

function parameterHintsFromObservedText(text = "", head = "") {
  const rest = String(text || "").slice(String(head || "").length).trim()
  const hints: CommandParameterHint[] = []
  const add = (name: string, description: string): void => {
    if (!hints.some(item => item.name === name)) hints.push({ name, description })
  }
  if (!rest) return hints
  if (/@\d+|\[CQ:at/i.test(rest)) add("@用户", "真实样例中包含 @ 用户。")
  if (/\d/.test(rest)) add("数字", "真实样例中包含数字参数。")
  if (rest.length > 0) add("内容", "真实样例中包含后续文本参数。")
  return hints.slice(0, 8)
}

function commandSignature(text = "", prefixes: string[] = []): string {
  const head = commandHead(text, prefixes)
  if (!head) return ""
  const rest = String(text || "").slice(head.length).trim()
  const slots = []
  if (/@\d+|\[CQ:at/i.test(rest)) slots.push("@用户")
  if (/\d/.test(rest)) slots.push("数字")
  if (rest.replace(/@\d+|\[CQ:at[^\]]+]/ig, "").replace(/\d+/g, "").trim()) slots.push("内容")
  return `${head}${slots.length ? ` ${slots.map(slot => `<${slot}>`).join(" ")}` : ""}`
}

class CommandObserver {
  /** 当前指令投影；静态、手动和动态条目统一使用同一领域记录。 */
  commands: CommandRecord[] = []
  events: CommandEvent[] = []
  usageCounts: Map<string, number> = new Map()
  afterHandlers: Array<(event: UnknownRecord) => Promise<void> | void> = []
  initialized = false
  patched = false
  originalDeal: ((event: UnknownRecord) => Promise<unknown> | unknown) | null = null
  saveTimer: ReturnType<typeof setTimeout> | null = null
  saveInFlight: Promise<unknown> | null = null
  commandsSaveTimer: ReturnType<typeof setTimeout> | null = null
  commandsSaveInFlight: Promise<unknown> | null = null

  /** 初始化知识库、加载持久化投影，并在需要时挂接宿主插件分发器。 */
  async init({ scanOnReady = true }: ObserverOptions = {}): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    await configStore.load()
    await this.load()
    this.patchDeal()
    if (!scanOnReady) return
    const scan = (): void => { void this.scan().catch(err => hostRuntime.logger?.warn?.("[yui-chat] 指令知识库扫描失败", err)) }
    if (hostRuntime.bot?.stat?.online === 2) scan()
    else hostRuntime.bot?.once?.("online", () => setTimeout(scan, 1000))
  }

  async load(): Promise<void> {
    const [events, commands] = await Promise.all([
      eventsRepository.load(),
      commandIndexStorage.load(),
    ])
    this.events = events
    this.commands = commands.map(commandRecord)
    const overrides = this.commands.filter(item => item.manual)
    const overriddenIds = new Set(overrides.map(item => safeText(item.overridesCommandId)).filter(Boolean))
    const overriddenRuleKeys = new Set(overrides.map(item => safeText(item.overridesSourceRuleKey)).filter(Boolean))
    if (overriddenIds.size || overriddenRuleKeys.size) this.commands = this.commands.filter(item => item.manual || (!overriddenIds.has(safeText(item.id)) && !overriddenRuleKeys.has(safeText(item.sourceRuleKey))))
    this.rebuildUsageCounts()
  }

  async save(): Promise<void> {
    await Promise.all([this.saveCommands(), this.saveEvents()])
  }

  async saveCommands(): Promise<void> {
    await commandIndexStorage.saveAll(this.commands)
  }

  async saveObservedCommands(): Promise<void> {
    await commandIndexStorage.saveObserved(this.commands)
  }

  async saveManualCommands(): Promise<void> {
    await commandIndexStorage.saveManual(this.commands)
  }

  async saveEvents(): Promise<void> {
    await eventsRepository.replace(this.events)
  }

  scheduleEventsSave(delayMs = 1500): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushEvents().catch(err => hostRuntime.logger?.debug?.("[yui-chat] 指令事件写入失败", err))
    }, delayMs)
  }

  scheduleCommandsSave(delayMs = 1500): void {
    if (this.commandsSaveTimer) clearTimeout(this.commandsSaveTimer)
    this.commandsSaveTimer = setTimeout(() => {
      this.commandsSaveTimer = null
      this.flushCommands().catch(err => hostRuntime.logger?.debug?.("[yui-chat] 动态指令索引写入失败", err))
    }, delayMs)
  }

  async flushCommands(): Promise<unknown> {
    if (this.commandsSaveInFlight) return this.commandsSaveInFlight
    this.commandsSaveInFlight = this.saveObservedCommands().finally(() => {
      this.commandsSaveInFlight = null
    })
    return this.commandsSaveInFlight
  }

  async flushEvents(): Promise<unknown> {
    if (this.saveInFlight) return this.saveInFlight
    this.saveInFlight = this.saveEvents().finally(() => {
      this.saveInFlight = null
    })
    return this.saveInFlight
  }

  rebuildUsageCounts(): void {
    const usage = new Map<string, number>()
    for (const event of this.events || []) {
      for (const id of [...(event.exactMatches || []), ...(event.matches || [])]) {
        usage.set(id, (usage.get(id) || 0) + 1)
      }
    }
    this.usageCounts = usage
  }

  addUsageCounts(event: CommandEvent = {}): void {
    for (const id of [...(event.exactMatches || []), ...(event.matches || [])]) {
      this.usageCounts.set(id, (this.usageCounts.get(id) || 0) + 1)
    }
  }

  upsertObservedCommand(event: CommandEvent = {}): CommandRecord | null {
    if (event.exactMatches?.length) return null
    const doc = buildObservedCommandDoc(event)
    if (!doc) return null
    const index = this.commands.findIndex(item => item.id === doc.id)
    if (index < 0) {
      const compact = compactCommandDoc(doc)
      const normalized = commandRecord(compact)
      this.commands.push(normalized)
      return normalized
    }
    const current = this.commands[index]
    const samples = [
      event.text,
      ...(current.observed?.samples || []),
    ].filter(Boolean)
    const next = buildCommandDoc({
      ...current,
      helpDocs: [
        ...(current.helpDocs || []).filter(item => item.source !== "dynamic-events"),
        { source: "dynamic-events", text: safeText([event.text, current.searchText, event.handledBy].join(" ")).slice(0, 2000) },
      ],
      observed: {
        ...(current.observed || {}),
        lastSeenAt: event.time,
        count: Number(current.observed?.count || 0) + 1,
        handledBy: event.handledBy || current.observed?.handledBy || "",
        samples: [...new Set(samples)].slice(0, 5),
        signatures: [...new Set([event.signature, ...(current.observed?.signatures || [])].filter(Boolean))].slice(0, 8),
      },
      updatedAt: event.time || new Date().toISOString(),
    })
    next.commandHeads = [...new Set([event.commandHead, ...(current.commandHeads || [])].filter((value): value is string => Boolean(value)))].slice(0, 12)
    next.intentHints = [...new Set([...(current.intentHints || []), ...intentHintsFromText(`${event.text || ""} ${event.handledBy || ""}`)])].slice(0, 8)
    next.parameterHints = mergeParameterHints(
      current.parameterHints || [],
      parameterHintsFromObservedText(event.text, event.commandHead),
    )
    next.usageGuide = {
      ...(next.usageGuide || {}),
      heads: next.commandHeads,
      intents: next.intentHints,
      parameters: next.parameterHints,
      confidence: "observed",
    }
    this.commands[index] = commandRecord(compactCommandDoc(next))
    return this.commands[index]
  }

  async scan() {
    const priority = pluginsLoader.priority
    if (!this.initialized) {
      throw observerError("指令扫描器尚未初始化，请等待机器人运行时加载完成后再试。", "COMMAND_OBSERVER_NOT_READY")
    }
    if (!Array.isArray(priority) || !priority.length) {
      throw observerError("当前机器人插件运行时尚未完成加载，暂不刷新指令索引；请稍后重试。", "COMMAND_RUNTIME_UNAVAILABLE")
    }
    const rows: CommandRecord[] = []
    resetCommandSourceLocator()
    const observedRows = this.commands.filter(item => item.dynamic || item.pluginKey === "observed" || item.manual || item.pluginKey === "manual")
    // 静态指令只信任运行态规则；README 和其他插件文档不进入指令索引。
    for (const item of priority) {
      const plugin = item.plugin || {}
      for (const [ruleIndex, rule] of (plugin.rule || []).entries()) {
        const regexp = serializeRegExp(rule.reg)
        if (isEphemeralInternalRule(regexp)) continue
        rows.push(commandRecord(compactCommandDoc(buildCommandDoc({
          id: `${safeText(item.key)}:${safeText(plugin.name)}:${safeText(rule.fnc)}:${regexp}`,
          pluginKey: item.key,
          pluginName: plugin.name,
          description: plugin.dsc || "",
          fnc: rule.fnc,
          regexp,
          permission: rule.permission || "all",
          event: rule.event || plugin.event || "message",
          priority: Number(item.priority || 0),
          sourceRuleKey: `${safeText(item.key)}:${safeText(rule.fnc)}:${ruleIndex}`,
          origin: await runtimeRuleOrigin(item, plugin, rule),
          updatedAt: new Date().toISOString(),
        }))))
      }
    }
    if (!rows.length && this.commands.some(item => !item.dynamic && !item.manual && item.pluginKey !== "observed" && item.pluginKey !== "manual")) {
      throw observerError("插件运行时未返回可用指令，已保留原有指令索引。", "COMMAND_SCAN_EMPTY")
    }
    const overriddenIds = new Set(observedRows.map(row => safeText(row.overridesCommandId)).filter(Boolean))
    const overriddenRuleKeys = new Set(observedRows.map(row => safeText(row.overridesSourceRuleKey)).filter(Boolean))
    const merged = new Map<string, CommandRecord>()
    for (const row of [...rows.filter(row => !overriddenIds.has(safeText(row.id)) && !overriddenRuleKeys.has(safeText(row.sourceRuleKey))), ...observedRows]) merged.set(commandIdentity(row), row)
    this.commands = [...merged.values()]
    await commandIndexStorage.saveStatic(this.commands)
    return this.commands
  }

  scanStatus(): UnknownRecord {
    return {
      initialized: this.initialized,
      patched: this.patched,
      pluginRuntimeReady: Array.isArray(pluginsLoader.priority) && pluginsLoader.priority.length > 0,
      pluginCount: Array.isArray(pluginsLoader.priority) ? pluginsLoader.priority.length : 0,
    }
  }

  patchDeal(): void {
    if (this.patched || pluginsLoader.__yuiChatObserved || typeof pluginsLoader.deal !== "function") return
    const originalDeal = pluginsLoader.deal.bind(pluginsLoader)
    this.originalDeal = originalDeal
    pluginsLoader.deal = async e => {
      try {
        return await originalDeal(e)
      } finally {
        this.capture(e).catch(err => hostRuntime.logger?.debug?.("[yui-chat] 指令事件记录失败", err))
        this.runAfterHandlers(e).catch(err => hostRuntime.logger?.debug?.("[yui-chat] 消息后置处理失败", err))
      }
    }
    pluginsLoader.__yuiChatObserved = true
    this.patched = true
  }

  async destroy({ restorePatch = false }: { restorePatch?: boolean } = {}): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.commandsSaveTimer) clearTimeout(this.commandsSaveTimer)
    this.saveTimer = null
    this.commandsSaveTimer = null
    await this.flushCommands()
    await this.flushEvents()
    this.afterHandlers = []
    this.initialized = false
    if (restorePatch && this.patched && this.originalDeal) {
      pluginsLoader.deal = this.originalDeal
      delete pluginsLoader.__yuiChatObserved
      this.patched = false
      this.originalDeal = null
    }
  }

  registerAfterHandler(handler: (event: UnknownRecord) => Promise<void> | void): void {
    if (typeof handler === "function" && !this.afterHandlers.includes(handler)) {
      this.afterHandlers.push(handler)
    }
  }

  async runAfterHandlers(e: UnknownRecord): Promise<void> {
    for (const handler of this.afterHandlers) await handler(e)
  }

  async capture(e: UnknownRecord): Promise<void> {
    const config = currentConfig()
    const knowledge = record(config.knowledge)
    if (!knowledge.enabled || !knowledge.dynamicCapture) return
    if (e.isPrivate && !knowledge.capturePrivate) return
    if (e.isGroup && !knowledge.captureGroups) return
    const msg = safeText(e.msg || e.raw_message || "")
    const prefixes = commandPrefixes(config)
    if (!msg || !isCommandMessage(msg, prefixes)) return
    const head = commandHead(msg, prefixes)
    const exactMatches = this.commands.filter(command => regexpMatches(command.regexp, msg)).slice(0, 10)
    const fuzzyMatches = this.findMatches(msg).slice(0, 5)
    const signature = commandSignature(msg, prefixes)
    const event: CommandEvent = {
      text: msg.slice(0, 300),
      commandHead: head,
      signature,
      commandPrefix: prefixes.find(prefix => msg.startsWith(prefix)) || "",
      commandPrefixes: prefixes,
      handledBy: stripAnsi(e.logFnc || ""),
      exactMatches: exactMatches.map(item => safeText(item.id)).filter(Boolean),
      matches: fuzzyMatches.map(item => safeText(item.id)).filter(Boolean),
      isGroup: Boolean(e.isGroup),
      groupId: e.isGroup ? String(e.group_id) : undefined,
      userId: e.user_id ? String(e.user_id) : undefined,
      time: new Date().toISOString(),
    }
    this.events.push(event)
    const observed = this.upsertObservedCommand(event)
    if (observed) event.observedCommandId = observed.id
    event.matchType = (event.exactMatches || []).length ? "exact" : observed ? "observed" : (event.matches || []).length ? "fuzzy" : "unmatched"
    this.addUsageCounts(event)
    const maxEvents = Math.max(10, Number(knowledge.maxEvents) || 1000)
    if (this.events.length > maxEvents) {
      this.events = this.events.slice(-maxEvents)
      this.rebuildUsageCounts()
    }
    if (observed) this.scheduleCommandsSave(Number(knowledge.flushDelayMs) || 1500)
    this.scheduleEventsSave(Number(knowledge.flushDelayMs) || 1500)
  }

  async upsertManualCommand(input: ManualCommandInput = {}): Promise<CommandRecord> {
    const doc = compactCommandDoc(buildManualCommandDoc(input))
    const identity = commandIdentity(doc)
    this.commands = this.commands.filter(item => item.id !== doc.id && commandIdentity(item) !== identity && (!doc.overridesCommandId || item.id !== doc.overridesCommandId) && (!doc.overridesSourceRuleKey || item.sourceRuleKey !== doc.overridesSourceRuleKey) && !(item.manual && ((doc.overridesCommandId && item.overridesCommandId === doc.overridesCommandId) || (doc.overridesSourceRuleKey && item.overridesSourceRuleKey === doc.overridesSourceRuleKey))))
    const normalized = commandRecord(doc)
    this.commands.push(normalized)
    await this.saveManualCommands()
    return normalized
  }

  isExcluded(command: CommandRecord = {}): boolean {
    const config = record(currentConfig().knowledge)
    const plugin = normalizedIdentityPart(command.pluginName || command.pluginKey)
    const excludedPlugins = new Set(normalizeStringList(config.excludedPlugins).map(normalizedIdentityPart))
    if (excludedPlugins.has(plugin)) return true
    const identity = commandIdentity(command)
    const commandText = normalizedIdentityPart(preferredCommandText(command) || command.suggestedCommand || command.regexp || command.fnc)
    const heads = (command.commandHeads || command.usageGuide?.heads || []).map(normalizedIdentityPart)
    return normalizeStringList(config.excludedCommands).some(item => {
      const value = normalizedIdentityPart(item)
      return value === identity || value === commandText || heads.some(head => value === head || value === `${plugin}::${head}`)
    })
  }

  searchableCommands(): CommandRecord[] {
    return this.commands.filter(command => !this.isExcluded(command))
  }

  async deleteCuratedCommand(id = ""): Promise<UnknownRecord> {
    const targetId = safeText(id)
    if (!targetId) throw new Error("知识条目 ID 不能为空")
    const current = this.commands.find(item => item.id === targetId)
    if (!current) throw new Error(`未找到知识条目：${targetId}`)
    if (!(current.manual || current.pluginKey === "manual" || current.dynamic || current.pluginKey === "observed")) {
      throw new Error("只能删除手动补充或动态观察条目，静态扫描条目请调整来源规则或帮助文档。")
    }
    this.commands = this.commands.filter(item => item.id !== targetId)
    this.events = this.events.map(event => ({
      ...event,
      exactMatches: (event.exactMatches || []).filter(item => item !== targetId),
      matches: (event.matches || []).filter(item => item !== targetId),
      observedCommandId: event.observedCommandId === targetId ? undefined : event.observedCommandId,
    }))
    this.rebuildUsageCounts()
    if (commandKind(current) === "manual") await this.saveManualCommands()
    else await this.saveObservedCommands()
    await this.saveEvents()
    return { id: targetId, deleted: 1 }
  }

  findMatches(query: unknown, limit = 10): UnknownRecord[] {
    return findCommandMatches(this.searchableCommands(), query, {
      limit,
      usageCounts: this.usageCounts,
      commandPrefixes: commandPrefixes(configStore.get()),
    })
  }

  recommendCommands(query: unknown, opts: UnknownRecord = {}): UnknownRecord {
    return buildCommandRecommendations(this.searchableCommands(), query, {
      ...opts,
      usageCounts: this.usageCounts,
      commandPrefixes: commandPrefixes(configStore.get()),
    })
  }

  async recommendCommandsHybrid(query: unknown, opts: UnknownRecord = {}): Promise<CommandRecommendationResponse> {
    const result = await recommendCommandHybrid(this, query, opts)
    return {
      ...result,
      results: Array.isArray(result.results) ? result.results : [],
    }
  }

  digest(opts: UnknownRecord = {}): UnknownRecord {
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20))
    return buildCommandDigest(this.searchableCommands(), this.events, {
      limit,
      usageCounts: this.usageCounts,
      stats: this.stats(),
      observer: this.observerStatus(),
      capture: this.captureDigest(limit),
    })
  }

  qualityReport(opts: UnknownRecord = {}): UnknownRecord {
    return buildCommandQualityReport(this.searchableCommands(), {
      ...opts,
      usageCounts: this.usageCounts,
    })
  }

  stats(): CommandObserverStats {
    const commands = this.searchableCommands()
    return {
      commands: commands.length,
      excludedCommands: this.commands.length - commands.length,
      events: this.events.length,
      initialized: this.initialized,
      patched: this.patched,
      afterHandlers: this.afterHandlers.length,
      plugins: new Set(commands.map(item => item.pluginKey)).size,
      observedCommands: commands.filter(item => item.dynamic || item.pluginKey === "observed").length,
      manualCommands: commands.filter(item => item.manual || item.pluginKey === "manual").length,
      storage: {
        format: "split-json-v2",
        singleWriterOnly: true,
        files: {
          ...commandIndexStorage.files,
          events: eventsFile,
        },
      },
      exampleCoverageRatio: commands.length
        ? Number((commands.filter(item => item.suggestedCommand || item.example || item.examples?.length).length / commands.length).toFixed(4))
        : 0,
    }
  }

  observerStatus(): UnknownRecord {
    const config = currentConfig()
    const knowledge = record(config.knowledge)
    return {
      initialized: this.initialized,
      patched: this.patched,
      afterHandlers: this.afterHandlers.length,
      dynamicCapture: knowledge.dynamicCapture !== false,
      captureGroups: knowledge.captureGroups !== false,
      capturePrivate: Boolean(knowledge.capturePrivate),
      commandPrefixes: commandPrefixes(config),
      maxEvents: Number(knowledge.maxEvents || 1000),
      flushDelayMs: Number(knowledge.flushDelayMs || 1500),
    }
  }

  captureDigest(limit = 20): UnknownRecord {
    return buildCommandCaptureDigest(this.events, limit)
  }
}

export const commandObserver = new CommandObserver()
