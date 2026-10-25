import { cleanCommandRetrievalText } from "./command-retrieval-text.js"
import { prepareCommandCompleteness } from "./command-completeness.js"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { configStore, yunzaiRoot } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { commandPrefixes } from "../core/message/command-prefixes.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { commandImports } from "./command-import.js"
import { buildCommandDoc, type UnknownRecord } from "./command-document-builder.js"
import { buildCommandDigest, buildCommandQualityReport, buildCommandRecommendations, findCommandMatches } from "./command-query-service.js"
import { recommendCommandHybrid } from "./command-hybrid-retrieval.js"
import type { CommandRecord, CommandObserverStats, CommandRecommendationResponse, PluginsLoaderApi } from "./command-observer.types.js"
import type { CommandBundle } from "./command-scanner.js"
export { buildCommandDoc } from "./command-document-builder.js"
const pluginsLoader = (await import(pathToFileURL(path.join(yunzaiRoot, "lib/plugins/loader.js")).href)).default as PluginsLoaderApi

/** Imported SQLite documents are the single command catalogue; the host hook only delivers after-handlers. */
class CommandObserver {
  commands: CommandRecord[] = []
  events: UnknownRecord[] = []
  usageCounts = new Map<string, number>()
  afterHandlers: Array<(event: UnknownRecord) => Promise<void> | void> = []
  initialized = false
  patched = false
  originalDeal: ((event: UnknownRecord) => Promise<unknown> | unknown) | null = null
  collection: Promise<CommandBundle> | null = null
  collectLoadedCommands(): Promise<CommandBundle> {
    if (this.collection) return this.collection
    if (!Array.isArray(pluginsLoader.priority)) return Promise.reject(new Error("当前宿主未提供已加载指令目录，请确认机器人完成启动"))
    this.collection = import("./command-scanner.js").then(({ scanLoadedCommands }) => scanLoadedCommands([...pluginsLoader.priority!])).finally(() => { this.collection = null })
    return this.collection
  }
  async init(): Promise<void> {
    if (this.initialized) return
    await configStore.load()
    await this.load()
    this.initialized = true
    this.patchDeal()
  }
  async load(): Promise<void> {
    const rows = sqliteClient.status.available ? (await commandImports.list()).map(row => ({ ...row.metadata, id: row.id, title: row.title, metadata: row.metadata, retrievalText: cleanCommandRetrievalText(row.retrievalText, row.metadata), sourceId: row.sourceId, suggestedCommand: typeof row.metadata.suggestedCommand === "string" ? row.metadata.suggestedCommand : row.title, description: row.metadata.description || row.title, imported: true, enabled: row.enabled, commandEnabled: row.commandEnabled, pluginEnabled: row.pluginEnabled })) : []
    this.commands = rows.map(row => ({ ...buildCommandDoc(row), ...row })) as CommandRecord[]
    await prepareCommandCompleteness(this.commands)
  }
  applyAvailability(rows: UnknownRecord[]): void { const byId = new Map(rows.map(row => [String(row.id), row])); this.commands = this.commands.map(row => ({ ...row, ...byId.get(String(row.id)) })) }
  searchableCommands(): CommandRecord[] { return this.commands.filter(row => row.enabled !== false) }
  findMatches(query: unknown, limit = 10): UnknownRecord[] { return findCommandMatches(this.searchableCommands(), query, { limit, commandPrefixes: commandPrefixes(configStore.get()), minRelevance: (configStore.get() as Record<string, any>).knowledge?.retrieval?.minRelevance }) }
  recommendCommands(query: unknown, options: UnknownRecord = {}): UnknownRecord { return buildCommandRecommendations(this.searchableCommands(), query, { ...options, commandPrefixes: commandPrefixes(configStore.get()), minRelevance: (configStore.get() as Record<string, any>).knowledge?.retrieval?.minRelevance }) }
  async recommendCommandsHybrid(query: unknown, options: UnknownRecord = {}): Promise<CommandRecommendationResponse> { const result = await recommendCommandHybrid(this, query, options); return { ...result, results: Array.isArray(result.results) ? result.results : [] } }
  digest(options: UnknownRecord = {}): UnknownRecord { return buildCommandDigest(this.commands, [], { ...options, observer: this.stats() }) }
  qualityReport(options: UnknownRecord = {}): UnknownRecord { return buildCommandQualityReport(this.commands, options) }
  stats(): CommandObserverStats { return { commands: this.commands.length, excludedCommands: this.commands.length - this.searchableCommands().length, events: 0, initialized: this.initialized, patched: this.patched, afterHandlers: this.afterHandlers.length, plugins: new Set(this.commands.map(row => row.pluginKey)).size, observedCommands: 0, manualCommands: 0, exampleCoverageRatio: this.commands.length ? this.commands.filter(row => row.examples?.length).length / this.commands.length : 0 } }
  registerAfterHandler(handler: (event: UnknownRecord) => Promise<void> | void): void { if (!this.afterHandlers.includes(handler)) this.afterHandlers.push(handler) }
  async runAfterHandlers(event: UnknownRecord): Promise<void> { for (const handler of this.afterHandlers) await handler(event) }
  patchDeal(): void {
    if (this.patched || pluginsLoader.__yuiChatObserved || typeof pluginsLoader.deal !== "function") return
    const original = pluginsLoader.deal.bind(pluginsLoader)
    this.originalDeal = original
    pluginsLoader.deal = async event => { try { return await original(event) } finally { this.runAfterHandlers(event).catch(error => hostRuntime.logger?.debug?.("[yui-chat] 消息后置处理失败", error)) } }
    pluginsLoader.__yuiChatObserved = true
    this.patched = true
  }
  async destroy({ restorePatch = false }: { restorePatch?: boolean } = {}): Promise<void> {
    this.afterHandlers = []; this.initialized = false
    if (restorePatch && this.patched && this.originalDeal) { pluginsLoader.deal = this.originalDeal; delete pluginsLoader.__yuiChatObserved; this.originalDeal = null; this.patched = false }
  }
}
export const commandObserver = new CommandObserver()
