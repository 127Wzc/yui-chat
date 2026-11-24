import { langfuseReporter } from "../observability/langfuse.js"
import { randomUUID } from "node:crypto"
import { configStore } from "../../config/store.js"
import { sqliteClient } from "../storage/sqlite/client.js"
import type { UnknownRecord } from "../message/types.js"
import { conversationScopeMatches, conversationStore, parseConversationKey } from "./conversation-store.js"
import { scopeFor } from "./chat-support.js"
import { artifactStore } from "../../tools/support/artifact-store.js"
import { errorSummary } from "../shared/error-details.js"
import { hostRuntime } from "../runtime/host-runtime.js"

export interface ConversationEntry extends UnknownRecord {
  sessionId?: string
  history?: unknown[]
  turns?: unknown[]
  usage?: UnknownRecord
  toolCalls?: number
  protocolState?: UnknownRecord
  lastSeen?: number
}

export type ConversationValue = ConversationEntry | unknown[]

export interface ConversationVersion {
  key: string
  scopeKey: string
  global: number
  keyGeneration: number
  scopeGeneration: number
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function emptyUsage(): UnknownRecord {
  return { input: 0, output: 0, total: 0, cached: 0, reasoning: 0 }
}

function configChat(config: unknown): UnknownRecord {
  return record(record(config).chat)
}

/** 会话状态层：负责内存历史、TTL、持久层清理和并发删除版本，不负责模型或工具执行。 */
export class ConversationState {
  readonly conversations = new Map<string, ConversationValue>()
  private mutationQueue: Promise<void> = Promise.resolve()
  private generationSequence = 0
  private globalGeneration = 0
  private readonly keyGenerations = new Map<string, number>()
  private readonly scopeGenerations = new Map<string, number>()
  private readonly activeVersions = new Set<ConversationVersion>()
  private readonly pendingWrites = new Map<string, Map<string, { at: number; retry: () => Promise<void> }>>()

  /** 写回耗尽短重试后由当前会话下次读取恢复；仍使用原来的 mutationQueue。 */
  retainWrite(key: string, turnId: string, retry: (() => Promise<void>) | null): void {
    if (!retry) {
      const writes = this.pendingWrites.get(key)
      writes?.delete(turnId)
      if (!writes?.size) this.pendingWrites.delete(key)
      return
    }
    const writes = this.pendingWrites.get(key) || new Map()
    writes.set(turnId, { at: Date.now(), retry })
    this.pendingWrites.set(key, writes)
  }

  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const pending = this.mutationQueue.then(() => operation(), () => operation())
    this.mutationQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  waitForMutations(): Promise<void> {
    return this.mutationQueue
  }

  captureVersion(event: unknown, key: string): ConversationVersion {
    const scopeKey = scopeFor(event)
    const version: ConversationVersion = {
      key,
      scopeKey,
      global: this.globalGeneration,
      keyGeneration: this.keyGenerations.get(key) || 0,
      scopeGeneration: this.scopeGenerations.get(scopeKey) || 0,
    }
    this.activeVersions.add(version)
    return version
  }

  isCurrent(version: ConversationVersion | null | undefined): boolean {
    if (!version) return false
    return version.global === this.globalGeneration
      && version.keyGeneration === (this.keyGenerations.get(version.key) || 0)
      && version.scopeGeneration === (this.scopeGenerations.get(version.scopeKey) || 0)
  }

  releaseVersion(version: ConversationVersion | null | undefined): void {
    if (!version) return
    this.activeVersions.delete(version)
    this.cleanupGenerations({ keys: [version.key], scopeKeys: [version.scopeKey] })
  }

  private cleanupGenerations(options: { keys?: string[]; scopeKeys?: string[] } = {}): void {
    for (const key of options.keys || []) {
      if (![...this.activeVersions].some(version => version.key === key)) this.keyGenerations.delete(key)
    }
    for (const scopeKey of options.scopeKeys || []) {
      if (![...this.activeVersions].some(version => version.scopeKey === scopeKey)) this.scopeGenerations.delete(scopeKey)
    }
  }

  private nextGeneration(): number {
    this.generationSequence += 1
    return this.generationSequence
  }

  prune(config: unknown = configStore.get()): void {
    const chat = configChat(config)
    const ttlMs = Math.max(60000, number(chat.conversationTtlMs, 6 * 60 * 60 * 1000))
    const maxScopes = Math.max(10, number(chat.maxConversationScopes, 1000))
    const now = Date.now()
    for (const [key, writes] of this.pendingWrites) {
      for (const [turnId, write] of writes) if (now - write.at > ttlMs) writes.delete(turnId)
      if (!writes.size) this.pendingWrites.delete(key)
    }
    for (const [key, value] of this.conversations) {
      const entry = Array.isArray(value) ? null : value
      const lastSeen = entry ? number(entry.lastSeen) : now
      if (now - lastSeen > ttlMs) this.conversations.delete(key)
    }
    while (this.conversations.size > maxScopes) {
      let oldestKey: string | null = null
      let oldest = Infinity
      for (const [key, value] of this.conversations) {
        const entry = Array.isArray(value) ? null : value
        const lastSeen = entry ? number(entry.lastSeen) : 0
        if (lastSeen < oldest) {
          oldest = lastSeen
          oldestKey = key
        }
      }
      if (!oldestKey) break
      this.conversations.delete(oldestKey)
    }
  }

  async getConversation(key: string, version: ConversationVersion | null = null): Promise<ConversationEntry> {
    if (!sqliteClient.status.available) throw new Error("SQLite 不可用，无法读取会话。")
    for (const write of [...(this.pendingWrites.get(key)?.values() || [])]) {
      try { await write.retry() }
      catch (error) { hostRuntime.logger?.warn?.("[yui-chat] 会话待写工具结果仍未恢复", errorSummary(error)) }
    }
    const value = this.conversations.get(key)
    if (value) {
      const entry = Array.isArray(value) ? { history: value } : value
      if (!entry.sessionId) entry.sessionId = randomUUID()
      this.conversations.set(key, entry)
      return entry
    }
    const stored = await conversationStore.get(key)
    // 同一归属的并发首轮可能一起读到空存储，采用已经创建的会话身份。
    if ((!version || this.isCurrent(version)) && this.conversations.has(key)) return this.getConversation(key, version)
    if (stored && (!version || this.isCurrent(version))) {
      if (!stored.sessionId) stored.sessionId = randomUUID()
      this.conversations.set(key, stored)
      return stored
    }
    if (stored) return stored
    const entry = { history: [], sessionId: randomUUID(), lastSeen: Date.now() }
    if (!version || this.isCurrent(version)) this.conversations.set(key, entry)
    return entry
  }

  async getHistory(key: string, version: ConversationVersion | null = null): Promise<unknown[]> {
    return list((await this.getConversation(key, version)).history)
  }

  conversationKey(event: unknown, channelId: unknown): string {
    return `${text(channelId)}:${scopeFor(event)}`
  }

  scopeMatches(parsed: ReturnType<typeof parseConversationKey>, event: unknown, userId?: unknown): boolean {
    const value = record(event)
    return conversationScopeMatches(parsed, { isGroup: value.isGroup === true, groupId: value.group_id, userId: userId === undefined ? value.user_id : userId })
  }

  async clear(event: unknown, options: unknown = {}): Promise<number> {
    const value = record(event)
    const opts = record(options)
    const userIds = Array.isArray(opts.userIds) && opts.userIds.length ? opts.userIds : [value.user_id]
    const scopeKeys = userIds.map(userId => scopeFor(event, userId))
    for (const scopeKey of scopeKeys) this.scopeGenerations.set(scopeKey, this.nextGeneration())
    return this.enqueue(async () => {
      try {
        const persistedKeys = await conversationStore.clearScopeKeys({ isGroup: value.isGroup === true, groupId: value.group_id, userIds })
        const clearedKeys = new Set(persistedKeys)
        for (const key of [...this.conversations.keys()]) {
          const parsed = parseConversationKey(key)
          if (!userIds.some(userId => this.scopeMatches(parsed, event, userId))) continue
          this.conversations.delete(key)
          clearedKeys.add(key)
        }
        await langfuseReporter.resetScopes(scopeKeys)
        artifactStore.clearKeys(clearedKeys)
        artifactStore.clearWhere(key => userIds.some(userId => this.scopeMatches(parseConversationKey(key), event, userId)))
        for (const key of this.pendingWrites.keys()) {
          if (userIds.some(userId => this.scopeMatches(parseConversationKey(key), event, userId))) this.pendingWrites.delete(key)
        }
        return clearedKeys.size
      } finally {
        this.cleanupGenerations({ scopeKeys })
      }
    })
  }

  async clearAll(options: { preserveObservationSessions?: boolean } = {}): Promise<number> {
    this.globalGeneration = this.nextGeneration()
    this.keyGenerations.clear()
    this.scopeGenerations.clear()
    return this.enqueue(async () => {
      const clearedKeys = new Set(await conversationStore.clearAllKeys())
      for (const key of this.conversations.keys()) clearedKeys.add(key)
      this.conversations.clear()
      this.pendingWrites.clear()
      if (!options.preserveObservationSessions) await langfuseReporter.resetScopes()
      artifactStore.clear()
      return clearedKeys.size
    })
  }

  async clearByKeys(keys: unknown[] = []): Promise<number> {
    const normalized = [...new Set((Array.isArray(keys) ? keys : []).map(text).filter(Boolean))]
    for (const key of normalized) this.keyGenerations.set(key, this.nextGeneration())
    return this.enqueue(async () => {
      try {
        const clearedKeys = new Set(await conversationStore.clearKeys(normalized))
        for (const key of normalized) {
          if (this.conversations.delete(key)) clearedKeys.add(key)
          this.pendingWrites.delete(key)
        }
        await langfuseReporter.resetScopes(normalized.map(key => parseConversationKey(key).scope).filter(Boolean))
        artifactStore.clearKeys(normalized)
        return clearedKeys.size
      } finally {
        this.cleanupGenerations({ keys: normalized })
      }
    })
  }

  stats(): { conversations: number } {
    return { conversations: this.conversations.size }
  }

  list(options: unknown = {}): UnknownRecord[] {
    this.prune(configStore.get())
    const rows: UnknownRecord[] = []
    for (const [key, value] of this.conversations) {
      const parsed = parseConversationKey(key)
      const entry = Array.isArray(value) ? {} : value
      const history = Array.isArray(value) ? value : list(entry.history)
      const turns = Array.isArray(entry.turns) ? entry.turns : []
      const visibleHistory = history.map(record).filter(message => ["user", "assistant"].includes(text(message.role)) && text(message.content).trim())
      const lastSeen = Array.isArray(value) ? 0 : number(entry.lastSeen)
      rows.push({
        ...parsed,
        historyMessages: visibleHistory.length,
        turns: Math.max(turns.length, visibleHistory.filter(message => message.role === "user").length),
        lastSeen,
        lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : "",
        preview: text(visibleHistory.at(-1)?.content).slice(0, 80),
        usage: entry.usage || emptyUsage(),
        toolCalls: number(entry.toolCalls),
        lastTurn: turns.at(-1) || null,
      })
    }
    const sorted = rows.sort((a, b) => number(b.lastSeen) - number(a.lastSeen))
    const opts = record(options)
    const limit = opts.limit === undefined ? sorted.length : Math.max(0, number(opts.limit))
    return limit ? sorted.slice(0, limit) : sorted
  }
}
