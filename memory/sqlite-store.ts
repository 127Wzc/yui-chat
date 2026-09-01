import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { memoryRepository } from "./repository.js"
import { statusFor } from "./decay.js"
import { buildMemoryPrompt } from "./prompt.js"
import { resolveMemoryRecallPlan, retrieveMemory } from "./retrieval.js"
import { groupKey, scopeKey, scopesFor, userKey } from "./scopes.js"
import type { MemoryScope } from "./scopes.js"
import { vectorRecall } from "./vector-recall.js"
import { validateMemoryWrite } from "./write-policy.js"

type UnknownRecord = Record<string, unknown>

interface MemoryRow extends UnknownRecord {
  id?: string
  type?: string
  text?: string
  scope_type?: string
  owner_id?: string
  group_id?: string
  tags?: unknown
  importance?: unknown
  confidence?: unknown
  status?: string
  source?: string
  fact_key?: unknown
  fact_value?: unknown
  last_confirmed_at?: unknown
  expires_at?: unknown
  created_at?: unknown
  updated_at?: unknown
  computedStatus?: string
}

interface StoreOptions extends UnknownRecord {
  owner?: unknown
  source?: unknown
  type?: unknown
  tags?: unknown
  importance?: unknown
  confidence?: unknown
  replace?: boolean
  limit?: unknown
  factLimit?: unknown
  includeCold?: boolean
  groupQuery?: unknown
  groupPage?: unknown
  memberQuery?: unknown
  memberLimit?: unknown
  pageSize?: unknown
  globalQuery?: unknown
  globalPage?: unknown
  query?: unknown
}

interface ScopedMemoryInput {
  scopeType?: unknown
  ownerId?: unknown
  groupId?: unknown
  id?: unknown
  text?: unknown
  tags?: unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function timestamp(value: unknown): string {
  const number = Number(value || 0)
  return number > 0 ? new Date(number).toISOString() : ""
}

function normalizeProfile(patch: UnknownRecord = {}): UnknownRecord {
  const allowed = ["name", "pronouns", "interests", "preferences", "dislikes", "communicationStyle", "notes"]
  const result: UnknownRecord = {}
  for (const key of allowed) {
    if (patch[key] === undefined || patch[key] === null) continue
    if (Array.isArray(patch[key])) {
      result[key] = (patch[key] as unknown[]).map(item => String(item || "").trim()).filter(Boolean)
        .map(item => validateMemoryWrite(item, { source: "manual" })).slice(0, 20)
    } else {
      const value = String(patch[key] || "").trim()
      result[key] = value ? validateMemoryWrite(value, { source: "manual" }) : ""
    }
  }
  return result
}

function toLegacy(row: MemoryRow = {}): UnknownRecord {
  const status = row.computedStatus || statusFor(row)
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    ownerType: row.scope_type,
    ownerId: row.owner_id,
    groupId: row.group_id,
    tags: row.tags || [],
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    status,
    lifecycle: {
      status,
      lastConfirmedAt: timestamp(row.last_confirmed_at),
      expiresAt: timestamp(row.expires_at),
    },
    source: row.source,
    factKey: String(row.fact_key || row.factKey || ""),
    factValue: String(row.fact_value || row.factValue || ""),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    lastSeenAt: timestamp(row.last_confirmed_at),
    expiresAt: timestamp(row.expires_at),
    resultType: row.type === "episode" ? "episode" : "memory",
  }
}

function managedScope(scopeType: unknown, ownerId: unknown, groupId: unknown = ""): MemoryScope | null {
  const type = String(scopeType || "").trim()
  const owner = String(ownerId || "").trim()
  const group = String(groupId || "").trim()
  if (type === "user" && owner) return { scopeType: type, ownerId: owner, groupId: "" }
  if (type === "group" && owner) return { scopeType: type, ownerId: owner, groupId: owner }
  if (type === "user_group" && owner && group) return { scopeType: type, ownerId: owner, groupId: group }
  return null
}

function pageView(page: UnknownRecord = {}): UnknownRecord {
  const items = Array.isArray(page.items) ? page.items : []
  return {
    items: items.map(item => toLegacy(record(item))),
    total: Number(page.total || 0),
    page: Number(page.page || 1),
    pageSize: Number(page.pageSize || 20),
  }
}

function isManagedMemory(item: MemoryRow = {}): boolean {
  return item.type !== "profile" && item.type !== "short" && !(item.type === "episode" && item.source === "interaction")
}

export class SqliteMemoryStore {
  loaded = false
  statsCache: { users: number; groups: number; scopes: number; profiles: number; memories: number; episodeFiles: number; pendingWrites: number } = { users: 0, groups: 0, scopes: 0, profiles: 0, memories: 0, episodeFiles: 0, pendingWrites: 0 }

  async load(): Promise<typeof this.statsCache | null> {
    if (!sqliteClient.status.available) return null
    if (!this.loaded) {
      await this.refreshStats()
      this.loaded = true
      // 异步补齐向量索引（去抖 + 后台执行），不阻塞启动，也不影响未启用向量召回的部署。
      vectorRecall.markDirty()
    }
    return this.statsCache
  }

  async flush(): Promise<void> {
    if (!sqliteClient.status.available) return
    const memory = record(record(configStore.get()).memory)
    const retention = record(memory.retention)
    await memoryRepository.deleteExpired(retention.expiredGraceDays)
    // 清理过期行后同步向量索引，让已过期记忆的向量随之删除。
    vectorRecall.markDirty()
    await this.refreshStats()
  }

  async save(): Promise<void> { await this.flush() }

  async refreshStats(): Promise<typeof this.statsCache> {
    if (!sqliteClient.status.available) return this.statsCache
    const rows = await sqliteClient.all<UnknownRecord>("SELECT type, scope_type, COUNT(*) AS count FROM memory_items WHERE status != 'deleted' GROUP BY type, scope_type")
    const count = (type: unknown = null, scope: unknown = null): number => rows.filter(row => (!type || row.type === type) && (!scope || row.scope_type === scope)).reduce((sum, row) => sum + Number(row.count || 0), 0)
    this.statsCache = {
      users: count(null, "user"),
      groups: count(null, "group"),
      scopes: count(null, "user_group"),
      profiles: count("profile"),
      memories: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
      episodeFiles: count("episode"),
      pendingWrites: 0,
    }
    return this.statsCache
  }

  async appendInteraction(_e: UnknownRecord, _prompt: unknown, _answer: unknown): Promise<void> {
    // 方法保留：memory/store.js 门面 Proxy 与 core/chat/chat-service.js 的调用点依赖它存在。
    // 但 SQLite 模式下不再写入任何数据——short 与 interaction episode 的读路径已全部关闭
    // （isManagedMemory、listPage、retrieveMemory 都会过滤这两类行），继续写只有写放大；
    // 短期上下文由 recent-context 承担，群记忆由 group-capture 提炼入库。
    // 文件存储模式（memory/file-store.js）保留旧行为。
    return
  }

  async addFact(e: UnknownRecord, fact: unknown, opts: StoreOptions = {}): Promise<MemoryRow | null> {
    await this.load()
    const text = validateMemoryWrite(fact, { source: opts.source || "manual" })
    const owner: MemoryScope = opts.owner === "group" && e.isGroup
      ? { scopeType: "group", ownerId: groupKey(e), groupId: groupKey(e) }
      : opts.owner === "scope" && e.isGroup
        ? { scopeType: "user_group", ownerId: userKey(e), groupId: groupKey(e) }
        : { scopeType: "user", ownerId: userKey(e), groupId: "" }
    const existing = (await memoryRepository.list([owner], { limit: 500, includeCold: true })).find(item => item.type === "fact" && item.normalized_key === text.toLowerCase())
    if (existing) return memoryRepository.update(existing.id, { lastConfirmedAt: Date.now(), confidence: Math.min(1, Number(existing.confidence || 0.8) + 0.04), status: "active", source: String(opts.source || existing.source || "manual") })
    const result = await memoryRepository.insert({ ...owner, type: String(opts.type || "fact"), text, normalized: text.toLowerCase(), tags: opts.tags || [], importance: opts.importance ?? 0.62, confidence: opts.confidence ?? 0.78, source: String(opts.source || "manual") })
    await this.refreshStats()
    return result
  }

  async getProfile(eOrUserId: UnknownRecord | string): Promise<UnknownRecord> {
    await this.load()
    const key = typeof eOrUserId === "object" ? userKey(eOrUserId) : String(eOrUserId || "unknown")
    const row = await memoryRepository.getProfileByOwner(key)
    const facts = (await memoryRepository.list([{ scopeType: "user", ownerId: key, groupId: "" }], { limit: 50, includeCold: true })).filter(item => item.type === "fact").map(toLegacy)
    return { userId: key, profile: row?.profile || {}, facts, updatedAt: timestamp(row?.updated_at) }
  }

  async listProfiles(opts: StoreOptions = {}): Promise<UnknownRecord[]> {
    await this.load()
    const rows = await memoryRepository.listProfiles(opts.limit || 50)
    const factsByOwner = await memoryRepository.listFactsByOwners(rows.map(row => row.owner_id), { factLimit: opts.factLimit || 3 })
    return rows.map(row => {
      const facts = (factsByOwner.get(String(row.owner_id || "")) || []).map(toLegacy)
      return { userId: row.owner_id, profile: row.profile || {}, facts, factCount: facts.length, updatedAt: timestamp(row.updated_at), summary: [] }
    })
  }

  async listManagedScopes(opts: StoreOptions = {}): Promise<UnknownRecord[]> {
    await this.load()
    const rows = await memoryRepository.listManagedScopes(opts)
    return rows.map(row => ({
      scopeType: row.scope_type,
      ownerId: row.owner_id,
      groupId: row.group_id || "",
      memoryCount: Number(row.memory_count || 0),
      profile: row.profile || {},
      updatedAt: timestamp(row.updated_at),
    }))
  }

  async getManagedScope(scopeType: unknown, ownerId: unknown): Promise<UnknownRecord> {
    await this.load()
    const scope = managedScope(scopeType, ownerId)
    if (!scope) throw new Error("记忆范围和对象 ID 不能为空。")
    const items = (await memoryRepository.list([scope], { limit: 200, includeCold: true }))
      .filter(isManagedMemory)
      .map(toLegacy)
    const profile = scope.scopeType === "user" ? (await this.getProfile(scope.ownerId)).profile : {}
    return { ...scope, profile, items }
  }

  async saveScopedMemory({ scopeType, ownerId, groupId, id, text, tags }: ScopedMemoryInput = {}): Promise<UnknownRecord> {
    await this.load()
    const scope = managedScope(scopeType, ownerId, groupId)
    if (!scope) throw new Error("记忆范围和对象 ID 不能为空。")
    const clean = validateMemoryWrite(text, { source: "manual" })
    if (!id) {
      const existing = (await memoryRepository.list([scope], { limit: 500, includeCold: true }))
        .find(item => item.type === "fact" && item.normalized_key === clean.toLowerCase())
      if (existing) {
        const result = await memoryRepository.update(existing.id, {
          lastConfirmedAt: Date.now(), confidence: Math.min(1, Number(existing.confidence || 0.8) + 0.04), status: "active", source: "manual",
        })
        await this.refreshStats()
        return toLegacy(result || {})
      }
      const result = await memoryRepository.insert({
        ...scope, type: "fact", text: clean, normalized: clean.toLowerCase(), tags: tags || [],
        importance: 0.62, confidence: 0.78, source: "manual",
      })
      await this.refreshStats()
      return toLegacy(result || {})
    }
    const row = await memoryRepository.get(String(id))
    if (!row || row.scope_type !== scope.scopeType || row.owner_id !== scope.ownerId || (row.group_id || "") !== scope.groupId) throw new Error("未找到这条长期记忆。")
    const result = await memoryRepository.update(row.id, {
      text: clean,
      normalized: clean.toLowerCase(),
      tags: Array.isArray(tags) ? tags : row.tags,
      lastConfirmedAt: Date.now(),
      status: "active",
      source: "manual-edit",
    })
    await this.refreshStats()
    return toLegacy(result || {})
  }

  async saveManagedMemory({ scopeType, ownerId, id, text, tags }: ScopedMemoryInput = {}): Promise<UnknownRecord> {
    return this.saveScopedMemory({ scopeType, ownerId, groupId: scopeType === "group" ? ownerId : "", id, text, tags })
  }

  async deleteScopedMemory({ scopeType, ownerId, groupId, memoryId }: ScopedMemoryInput & { memoryId?: unknown } = {}): Promise<UnknownRecord> {
    await this.load()
    const scope = managedScope(scopeType, ownerId, groupId)
    const row = await memoryRepository.get(String(memoryId || ""))
    if (!scope || !row || row.scope_type !== scope.scopeType || row.owner_id !== scope.ownerId || (row.group_id || "") !== scope.groupId) return { ok: false, id: memoryId }
    await memoryRepository.hardDelete(row.id)
    await this.refreshStats()
    return { ok: true, id: row.id, text: row.text }
  }

  async deleteManagedMemory(scopeType: unknown, ownerId: unknown, memoryId: unknown): Promise<UnknownRecord> {
    return this.deleteScopedMemory({ scopeType, ownerId, groupId: scopeType === "group" ? ownerId : "", memoryId })
  }

  async getGroupWorkspace(groupId: unknown, options: StoreOptions = {}): Promise<UnknownRecord> {
    await this.load()
    const key = String(groupId || "").trim()
    if (!key) throw new Error("群号不能为空。")
    const groupMemory = await memoryRepository.listPage(
      { scopeType: "group", ownerId: key, groupId: key },
      { query: options.groupQuery, page: options.groupPage, pageSize: options.pageSize, includeCold: true },
    )
    const members = await memoryRepository.listGroupMembers(key, { query: options.memberQuery, limit: options.memberLimit })
    return { groupId: key, groupMemory: pageView(groupMemory), members }
  }

  async getGroupMemberWorkspace(groupId: unknown, userId: unknown, options: StoreOptions = {}): Promise<UnknownRecord> {
    await this.load()
    const group = String(groupId || "").trim()
    const user = String(userId || "").trim()
    if (!group || !user) throw new Error("群号和用户 QQ 不能为空。")
    const [groupMemory, globalMemory, profile] = await Promise.all([
      memoryRepository.listPage({ scopeType: "user_group", ownerId: user, groupId: group }, {
        query: options.groupQuery, page: options.groupPage, pageSize: options.pageSize, includeCold: true,
      }),
      memoryRepository.listPage({ scopeType: "user", ownerId: user, groupId: "" }, {
        query: options.globalQuery, page: options.globalPage, pageSize: options.pageSize, includeCold: true,
      }),
      this.getProfile(user),
    ])
    return { userId: user, groupId: group, profile: profile.profile || {}, groupMemory: pageView(groupMemory), globalMemory: pageView(globalMemory) }
  }

  async setProfile(userId: unknown, patch: UnknownRecord = {}, opts: StoreOptions = {}): Promise<UnknownRecord> { return this.updateProfile({ user_id: String(userId), isGroup: false }, patch, opts) }

  async updateProfile(e: UnknownRecord, patch: UnknownRecord = {}, opts: StoreOptions = {}): Promise<UnknownRecord> {
    await this.load()
    const key = userKey(e)
    const current = await this.getProfile(key)
    const normalized = normalizeProfile(patch)
    const profile = opts.replace ? normalized : { ...record(current.profile), ...normalized }
    // 点查代替 listProfiles(1000).find：画像总量超过上限时也不会因找不到旧行而插入重复画像。
    const existing = await memoryRepository.getProfileByOwner(key)
    if (existing) await memoryRepository.update(existing.id, { text: JSON.stringify(profile), normalized: `profile:${key}`, tags: ["profile"], lastConfirmedAt: Date.now(), status: "active", source: "manual" })
    else await memoryRepository.insert({ scopeType: "user", ownerId: key, type: "profile", text: JSON.stringify(profile), normalized: `profile:${key}`, tags: ["profile"], importance: 1, confidence: 1, source: "manual" })
    await this.refreshStats()
    return this.getProfile(key)
  }

  async listMemories(e: UnknownRecord, opts: StoreOptions = {}): Promise<UnknownRecord[]> {
    await this.load()
    const scopes = opts.owner === "user" ? [{ scopeType: "user", ownerId: userKey(e), groupId: "" }] : scopesFor(e)
    const rows = await memoryRepository.list(scopes, { limit: opts.limit || 20, includeCold: opts.includeCold === true })
    return rows.filter(isManagedMemory).map(toLegacy)
  }

  async search(e: UnknownRecord, query: unknown, limit?: unknown): Promise<UnknownRecord[]> {
    await this.load()
    const retrieval = record(record(record(configStore.get()).memory).retrieval)
    return (await retrieveMemory(e, query, { limit, candidateLimit: retrieval.ftsCandidateLimit || 20 }))
      .filter(isManagedMemory)
      .map(toLegacy)
  }

  async forgetMemory(e: UnknownRecord, memoryId: unknown): Promise<UnknownRecord> {
    await this.load()
    const row = await memoryRepository.get(String(memoryId || ""))
    if (!row || !scopesFor(e).some(scope => scope.scopeType === row.scope_type && scope.ownerId === row.owner_id && (scope.groupId || "") === (row.group_id || ""))) return { ok: false, id: memoryId }
    await memoryRepository.hardDelete(row.id)
    await this.refreshStats()
    return { ok: true, id: row.id, text: row.text }
  }

  async updateMemory(userId: unknown, memoryId: unknown, patch: UnknownRecord = {}): Promise<MemoryRow | null> {
    await this.load()
    const row = await memoryRepository.get(String(memoryId || ""))
    if (!row || row.scope_type !== "user" || row.owner_id !== String(userId)) throw new Error("未找到这条长期记忆。")
    const text = validateMemoryWrite(patch.text, { source: "manual" })
    return memoryRepository.update(row.id, { text, normalized: text.toLowerCase(), tags: patch.tags || row.tags, importance: patch.importance ?? row.importance, confidence: patch.confidence ?? row.confidence, lastConfirmedAt: Date.now(), status: "active", source: "manual-edit" })
  }

  async buildPrompt(e: UnknownRecord, query: unknown): Promise<string> {
    const memory = record(record(configStore.get()).memory)
    const retrieval = record(memory.retrieval)
    if (memory.enabled === false) return ""
    const plan = await resolveMemoryRecallPlan(e, query)
    // 明确询问其他成员时不混入提问者画像；比较双方时仍保留提问者画像。
    const profile = memory.injectProfile === false || plan.mode === "target" ? {} : (await this.getProfile(e)).profile
    const memories = memory.injectRelevantFacts === false
      ? []
      : (await retrieveMemory(e, query, { scopes: plan.scopes, allowVector: plan.allowVector, candidateLimit: retrieval.ftsCandidateLimit || 20 }))
        .filter(isManagedMemory)
        .map(toLegacy)
    return buildMemoryPrompt({ profile, memories, tokenBudget: Number(retrieval.promptTokenBudget) || 2000 })
  }

  stats(): UnknownRecord { return { ...this.statsCache, storage: { format: "sqlite", worker: true, fts: true, vectors: Boolean(sqliteClient.status.vector?.available), vectorRecall: vectorRecall.stats() }, cache: {} } }

  async resetForTest(): Promise<void> { this.loaded = false; this.statsCache = { users: 0, groups: 0, scopes: 0, profiles: 0, memories: 0, episodeFiles: 0, pendingWrites: 0 } }
}

export const sqliteMemoryStore = new SqliteMemoryStore()
export { scopeKey, userKey }
