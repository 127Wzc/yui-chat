import { randomUUID } from "node:crypto"
import { defaultArtifactRetentionMs } from "../../config/defaults.js"

export interface ArtifactUsage {
  runId: string
  toolCallId: string
  tool: string
  at: number
}

export interface ArtifactEntry {
  id: string
  kind: "text" | "memory"
  title: string
  source: string
  runId: string
  toolCallId: string
  createdAt: number
  expiresAt: number
  lastUsedAt: number
  value: unknown
  bytes: number
  uses: ArtifactUsage[]
}

interface ArtifactScope {
  key: string
  sessionId: string
  userId: string
  groupId: string
  expiresAt: number
  ttlMs: number
  entries: Map<string, ArtifactEntry>
}

export interface ArtifactInput {
  kind: ArtifactEntry["kind"]
  title: string
  source: string
  runId?: string
  toolCallId?: string
  value: unknown
}

export interface ArtifactContext {
  create(input: ArtifactInput): ArtifactEntry
  list(): ArtifactEntry[]
  get(id: string, usage?: Omit<ArtifactUsage, "at">): ArtifactEntry
  snapshot(ids: string[]): ArtifactContext
}

// 缓存只保存完整资料；达到限额时淘汰整条，不截断传给下游工具的正文。
const MAX_SESSION_ENTRIES = 20
const MAX_CACHE_BYTES = 64 * 1024 * 1024

export class ArtifactStore {
  private readonly scopes = new Map<string, ArtifactScope>()

  private scopeId(key: string, sessionId: string): string { return JSON.stringify([key, sessionId]) }

  private prune(): void {
    const now = Date.now()
    for (const [id, scope] of this.scopes) {
      if (scope.expiresAt <= now) this.scopes.delete(id)
      else for (const [entryId, entry] of scope.entries) if (entry.expiresAt <= now) scope.entries.delete(entryId)
    }
  }

  open(input: { key: string; sessionId: string; userId: string; groupId: string; ttlMs?: number; maxScopes?: number; isCurrent?: () => boolean }): ArtifactContext {
    const isCurrent = input.isCurrent || (() => true)
    const ttlMs = Math.max(60000, Number(input.ttlMs) || defaultArtifactRetentionMs)
    if (!isCurrent()) {
      return this.context({ key: input.key, sessionId: input.sessionId, userId: input.userId, groupId: input.groupId, expiresAt: 0, ttlMs, entries: new Map() }, isCurrent)
    }
    this.prune()
    const scopeId = this.scopeId(input.key, input.sessionId)
    // 历史自动过期会更换会话 ID，但同一对话键的资料仍保留到独立期限；显式结束时已清理。
    let previousEntries: Map<string, ArtifactEntry> | undefined
    for (const [id, previous] of this.scopes) {
      if (previous.key !== input.key || id === scopeId) continue
      previousEntries = previous.entries
      this.scopes.delete(id)
    }
    const current = this.scopes.get(scopeId)
    const scope = current || { key: input.key, sessionId: input.sessionId, userId: input.userId, groupId: input.groupId, expiresAt: 0, ttlMs, entries: previousEntries || new Map<string, ArtifactEntry>() }
    scope.ttlMs = ttlMs
    scope.expiresAt = Math.max(Date.now() + ttlMs, ...[...scope.entries.values()].map(entry => entry.expiresAt))
    this.scopes.set(scopeId, scope)
    const maxScopes = Math.max(10, Number(input.maxScopes) || 1000)
    while (this.scopes.size > maxScopes) {
      const oldest = [...this.scopes.entries()].filter(([id]) => id !== scopeId).sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (!oldest) break
      this.scopes.delete(oldest[0])
    }
    return this.context(scope, isCurrent)
  }

  private context(scope: ArtifactScope, isCurrent: () => boolean, snapshot?: Map<string, ArtifactEntry>): ArtifactContext {
    const available = () => {
      if (snapshot) return snapshot
      this.prune()
      return isCurrent() && this.scopes.get(this.scopeId(scope.key, scope.sessionId)) === scope ? scope.entries : new Map<string, ArtifactEntry>()
    }
    const context: ArtifactContext = {
      create: input => {
        this.prune()
        if (snapshot || !isCurrent() || scope.expiresAt <= Date.now() || this.scopes.get(this.scopeId(scope.key, scope.sessionId)) !== scope) throw new Error("当前会话已结束，无法保存参考资料。")
        const serialized = JSON.stringify(input.value)
        if (serialized === undefined) throw new Error("参考资料不能序列化。")
        const bytes = Buffer.byteLength(serialized)
        if (bytes > MAX_CACHE_BYTES) throw new Error("参考资料过大，无法保存。")
        const now = Date.now()
        const entry: ArtifactEntry = { id: `ref_${randomUUID()}`, kind: input.kind, title: String(input.title || input.source).slice(0, 200), source: input.source, runId: input.runId || "", toolCallId: input.toolCallId || "", createdAt: now, expiresAt: now + scope.ttlMs, lastUsedAt: now, value: JSON.parse(serialized), bytes, uses: [] }
        scope.expiresAt = Math.max(scope.expiresAt, entry.expiresAt)
        scope.entries.set(entry.id, entry)
        while (scope.entries.size > MAX_SESSION_ENTRIES) {
          const oldest = [...scope.entries.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
          if (!oldest) break
          scope.entries.delete(oldest.id)
        }
        this.enforceCapacity()
        return entry
      },
      list: () => [...available().values()].sort((a, b) => b.createdAt - a.createdAt),
      get: (id, usage) => {
        const entry = available().get(id)
        if (!entry) throw new Error("参考资料不存在或已过期，请重新获取。")
        entry.lastUsedAt = Date.now()
        if (usage) entry.uses.push({ ...usage, at: entry.lastUsedAt })
        if (entry.uses.length > 100) entry.uses.splice(0, entry.uses.length - 100)
        return entry
      },
      snapshot: ids => {
        const entries = new Map<string, ArtifactEntry>()
        for (const id of ids) entries.set(id, context.get(id))
        return this.context({ ...scope, entries: new Map() }, () => true, entries)
      },
    }
    return context
  }

  private enforceCapacity(): void {
    const entries = [...this.scopes.values()].flatMap(scope => [...scope.entries.values()].map(entry => ({ scope, entry })))
    let total = entries.reduce((sum, item) => sum + item.entry.bytes, 0)
    for (const item of entries.sort((a, b) => a.entry.lastUsedAt - b.entry.lastUsedAt)) {
      if (total <= MAX_CACHE_BYTES) break
      item.scope.entries.delete(item.entry.id)
      total -= item.entry.bytes
    }
  }

  list(): Array<Omit<ArtifactEntry, "value" | "uses"> & { useCount: number; conversationKey: string; sessionId: string; userId: string; groupId: string }> {
    this.prune()
    return [...this.scopes.values()].flatMap(scope => [...scope.entries.values()].map(({ value: _value, uses, ...entry }) => ({ ...entry, useCount: uses.length, conversationKey: scope.key, sessionId: scope.sessionId, userId: scope.userId, groupId: scope.groupId }))).sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): (ArtifactEntry & { conversationKey: string; sessionId: string; userId: string; groupId: string }) | undefined {
    this.prune()
    for (const scope of this.scopes.values()) {
      const entry = scope.entries.get(id)
      if (entry) return { ...entry, conversationKey: scope.key, sessionId: scope.sessionId, userId: scope.userId, groupId: scope.groupId }
    }
    return undefined
  }

  delete(id: string): boolean {
    this.prune()
    for (const scope of this.scopes.values()) if (scope.entries.delete(id)) return true
    return false
  }

  clearKeys(keys: Iterable<string>): void {
    const selected = new Set(keys)
    for (const [id, scope] of this.scopes) if (selected.has(scope.key)) this.scopes.delete(id)
  }

  clearWhere(matches: (key: string) => boolean): void {
    for (const [id, scope] of this.scopes) if (matches(scope.key)) this.scopes.delete(id)
  }

  clear(): void { this.scopes.clear() }
}

export const artifactStore = new ArtifactStore()
