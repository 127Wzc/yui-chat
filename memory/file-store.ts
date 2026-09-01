import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { configStore, dataDir } from "../config/store.js"
import { writeFileAtomic } from "../core/storage/atomic-file.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { validateMemoryWrite } from "./write-policy.js"

const memoryDir = path.join(dataDir, "memory")

const ACTIVE_STATUSES = new Set(["active", "warm"])
const JSONL_BYTES_PER_ROW = 4096
const MAX_JSONL_TAIL_BYTES = 8 * 1024 * 1024

type UnknownRecord = Record<string, unknown>

interface MemoryEvent extends UnknownRecord {
  isGroup?: boolean
  group_id?: unknown
  user_id?: unknown
  sender?: UnknownRecord
}

interface MemoryOwner {
  type: "user" | "group" | "scope"
  id: string
  key: string
  dir: "users" | "groups" | "scopes"
  file: string
}

type ManagedScopeType = "user" | "group"

interface ProfileRow extends UnknownRecord {
  userId?: string
  profile?: UnknownRecord
  updatedAt?: string
}

interface ProfileResult extends UnknownRecord {
  userId: string
  profile: UnknownRecord
  facts: MemoryRow[]
  updatedAt?: string
}

interface MemoryRow extends UnknownRecord {
  id: string
  text: string
  status: string
  ownerType?: string
  ownerId?: string
  importance?: number
  confidence?: number
  hitCount?: number
  createdAt?: string
  updatedAt?: string
  lastSeenAt?: string
  lastUsedAt?: string
  tags?: string[]
}

interface EpisodeRow extends UnknownRecord {
  id: string
  prompt: string
  answer: string
  time: string
}

interface CacheEntry<T> {
  value: T
  touchedAt: number
  dirty?: boolean
}

interface WriteOptions extends UnknownRecord {
  save?: boolean
  immediate?: boolean
  replace?: boolean
  owner?: "user" | "group" | "scope"
  source?: unknown
  type?: unknown
  importance?: unknown
  confidence?: unknown
  tags?: unknown
}

interface MemoryStats {
  users: number
  groups: number
  scopes: number
  profiles: number
  memories: number
  episodeFiles: number
  pendingWrites: number
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function errorMessage(error: unknown): string {
  const source = record(error)
  return String(source.message || error || "")
}

function configRecord(): UnknownRecord {
  return record(configStore.get())
}

function memoryConfig(): UnknownRecord {
  return record(configRecord().memory)
}

function text(value: unknown = ""): string {
  return String(value).replace(/\s+/g, " ").trim()
}

function nowIso(): string {
  return new Date().toISOString()
}

function safePart(value: unknown = ""): string {
  return String(value || "unknown").replace(/[^\w.-]+/g, "_").slice(0, 96) || "unknown"
}

function scopeKey(e: MemoryEvent = {}): string {
  return e.isGroup ? `group:${e.group_id}` : `private:${e.user_id}`
}

function userKey(e: MemoryEvent = {}): string {
  return String(e.user_id || record(e.sender).user_id || "unknown")
}

function groupKey(e: MemoryEvent = {}): string {
  return e.isGroup ? String(e.group_id || "unknown") : ""
}

function scopeId(e: MemoryEvent = {}): string {
  if (e.isGroup) return `group_${safePart(e.group_id)}_user_${safePart(userKey(e))}`
  return `private_${safePart(userKey(e))}`
}

function tokenize(value: unknown = ""): string[] {
  return [...new Set(text(value).toLowerCase().split(/[^\p{L}\p{N}_#]+/u).filter(token => token.length >= 2))]
}

function normalizeProfilePatch(patch: UnknownRecord = {}): UnknownRecord {
  const allowed = ["name", "pronouns", "interests", "preferences", "dislikes", "communicationStyle", "notes"]
  const out: UnknownRecord = {}
  for (const key of allowed) {
    const value = patch[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) out[key] = value.map(item => text(item)).filter(Boolean).map(item => validateMemoryWrite(item, { source: "manual" }).slice(0, 80)).slice(0, 20)
    else {
      const clean = text(value)
      out[key] = clean ? validateMemoryWrite(clean, { source: "manual" }) : ""
    }
  }
  return out
}

function profileLines(profile: UnknownRecord = {}): string[] {
  const rows: string[] = []
  const list = (value: unknown): string[] => Array.isArray(value) ? value.map(item => text(item)).filter(Boolean) : []
  const interests = list(profile.interests)
  const preferences = list(profile.preferences)
  const dislikes = list(profile.dislikes)
  if (profile.name) rows.push(`称呼：${profile.name}`)
  if (profile.pronouns) rows.push(`代称：${profile.pronouns}`)
  if (interests.length) rows.push(`兴趣：${interests.join("、")}`)
  if (preferences.length) rows.push(`偏好：${preferences.join("、")}`)
  if (dislikes.length) rows.push(`不喜欢：${dislikes.join("、")}`)
  if (profile.communicationStyle) rows.push(`交流风格：${profile.communicationStyle}`)
  if (profile.notes) rows.push(`备注：${profile.notes}`)
  return rows
}

function memoryOwner(e: MemoryEvent = {}, owner: "user" | "group" | "scope" = "user"): MemoryOwner {
  const userId = userKey(e)
  const groupId = groupKey(e)
  if (owner === "group" && groupId) return { type: "group", id: groupId, key: `group:${groupId}`, dir: "groups", file: safePart(groupId) }
  if (owner === "scope") return { type: "scope", id: scopeId(e), key: `scope:${scopeId(e)}`, dir: "scopes", file: scopeId(e) }
  return { type: "user", id: userId, key: `user:${userId}`, dir: "users", file: safePart(userId) }
}

function managedScopeType(value: unknown): ManagedScopeType | "" {
  return value === "user" || value === "group" ? value : ""
}

function ownerType(value: unknown): MemoryOwner["type"] {
  return value === "group" || value === "scope" || value === "user" ? value : "user"
}

function isMemoryOwner(value: unknown): value is MemoryOwner {
  const item = record(value)
  return (item.type === "user" || item.type === "group" || item.type === "scope")
    && typeof item.id === "string"
    && typeof item.key === "string"
    && (item.dir === "users" || item.dir === "groups" || item.dir === "scopes")
    && typeof item.file === "string"
}

function lineJson(row: unknown): string {
  return `${JSON.stringify(row)}\n`
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch (err: unknown) {
    if (record(err).code !== "ENOENT") hostRuntime.logger?.warn?.(`[Yui-Chat][Memory] 读取 ${path.basename(file)} 失败`, err)
    return fallback
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeTextAtomic(file: string, value: string): Promise<void> {
  await writeFileAtomic(file, value)
}

async function appendLines(file: string, lines: readonly string[]): Promise<void> {
  if (!lines.length) return
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, lines.join(""), { encoding: "utf8", mode: 0o600 })
}

async function readJsonl<T extends UnknownRecord = UnknownRecord>(file: string, limit = 0): Promise<T[]> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(file, "r")
    const stat = await handle.stat()
    const maxBytes = limit > 0
      ? Math.max(64 * 1024, Math.min(MAX_JSONL_TAIL_BYTES, limit * JSONL_BYTES_PER_ROW))
      : stat.size
    const start = Math.max(0, stat.size - maxBytes)
    const buffer = Buffer.alloc(stat.size - start)
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start)
    const lines = buffer.toString("utf8").split(/\n+/)
    if (start > 0) lines.shift()
    const completeLines = lines.filter(Boolean)
    const selected = limit > 0 ? completeLines.slice(-limit) : completeLines
    const rows: T[] = []
    let invalidLines = 0
    for (const line of selected) {
      try {
        rows.push(JSON.parse(line) as T)
      } catch {
        invalidLines++
      }
    }
    if (invalidLines) hostRuntime.logger?.warn?.(`[Yui-Chat][Memory] ${path.basename(file)} 跳过 ${invalidLines} 行无效 JSONL`)
    return rows
  } catch (err: unknown) {
    if (record(err).code !== "ENOENT") hostRuntime.logger?.warn?.(`[Yui-Chat][Memory] 读取 ${path.basename(file)} 失败`, err)
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}

function memoryRank(row: MemoryRow, queryTokens: readonly string[] = []): number {
  const value = text(row.text).toLowerCase()
  const tokenScore = queryTokens.reduce((sum, token) => sum + (value.includes(token) ? token.length : 0), 0)
  const importance = Number(row.importance ?? 0.5)
  const confidence = Number(row.confidence ?? 0.7)
  const hits = Math.min(10, Number(row.hitCount || 0)) / 10
  const timestamp = row.lastUsedAt || row.updatedAt || row.lastSeenAt || row.createdAt
  const ageDays = timestamp
    ? (Date.now() - new Date(timestamp).getTime()) / 86400000
    : 999
  const freshness = Math.max(0, 1 - Math.min(ageDays, 180) / 180)
  return tokenScore * 2 + importance * 4 + confidence * 2 + hits + freshness
}

function rollingStatus(row: MemoryRow): string {
  if (row.status === "deleted" || row.status === "archived") return row.status
  const timestamp = row.lastUsedAt || row.updatedAt || row.lastSeenAt || row.createdAt
  const ageDays = timestamp
    ? (Date.now() - new Date(timestamp).getTime()) / 86400000
    : 999
  const importance = Number(row.importance ?? 0.5)
  const hits = Number(row.hitCount || 0)
  if (importance >= 0.75 || hits >= 6 || ageDays <= 30) return "active"
  if (importance >= 0.45 || hits >= 2 || ageDays <= 120) return "warm"
  return "cold"
}

class MemoryStore {
  data: { users: UnknownRecord; scopes: UnknownRecord } = { users: {}, scopes: {} }
  loaded = false
  rootDir = memoryDir
  profileCache = new Map<string, CacheEntry<ProfileRow>>()
  memoryCache = new Map<string, CacheEntry<MemoryRow[]>>()
  appendBuffers = new Map<string, string[]>()
  dirtyProfiles = new Set<string>()
  dirtyMemories = new Map<string, MemoryOwner>()
  flushTimer: ReturnType<typeof setTimeout> | null = null
  flushPromise: Promise<void> | null = null
  lastStats: MemoryStats = { users: 0, groups: 0, scopes: 0, profiles: 0, memories: 0, episodeFiles: 0, pendingWrites: 0 }

  async ensureDir(): Promise<void> {
    const dirs = [
      this.rootDir,
      path.join(this.rootDir, "profiles", "users"),
      path.join(this.rootDir, "profiles", "groups"),
      path.join(this.rootDir, "profiles", "scopes"),
      path.join(this.rootDir, "memories", "users"),
      path.join(this.rootDir, "memories", "groups"),
      path.join(this.rootDir, "memories", "scopes"),
      path.join(this.rootDir, "episodes"),
      path.join(this.rootDir, "index"),
    ]
    await Promise.all(dirs.map(dir => fs.mkdir(dir, { recursive: true })))
  }

  ownerPath(owner: MemoryOwner, kind: "profile" | "memory"): string {
    const dir = kind === "profile" ? "profiles" : "memories"
    const ext = kind === "profile" ? "json" : "jsonl"
    return path.join(this.rootDir, dir, owner.dir, `${owner.file}.${ext}`)
  }

  episodeFile(e: MemoryEvent = {}): string {
    return path.join(this.rootDir, "episodes", e.isGroup ? `group_${safePart(e.group_id)}.jsonl` : `private_${safePart(userKey(e))}.jsonl`)
  }

  async compactEpisodeFile(file: string): Promise<number> {
    const maxRows = Math.max(10, Number(memoryConfig().maxEpisodesPerScope) || 100)
    const rows = await readJsonl<EpisodeRow>(file, maxRows)
    await writeTextAtomic(file, rows.map(lineJson).join(""))
    return rows.length
  }

  async load(): Promise<{ users: UnknownRecord; scopes: UnknownRecord }> {
    if (this.loaded) return this.data
    await this.ensureDir()
    this.loaded = true
    await this.refreshStats()
    return this.data
  }

  touchCache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, limit: number): T {
    map.set(key, { ...(map.get(key) || {}), value, touchedAt: Date.now() })
    if (map.size <= limit) return value
    const victims = [...map.entries()].sort((a, b) => (a[1].touchedAt || 0) - (b[1].touchedAt || 0)).slice(0, Math.max(1, map.size - limit))
    for (const [victimKey, entry] of victims) {
      if (entry.dirty || this.dirtyProfiles.has(victimKey)) continue
      map.delete(victimKey)
    }
    return value
  }

  cacheLimit(): number {
    return Math.max(32, Number(memoryConfig().cacheEntries) || 384)
  }

  async loadProfile(owner: MemoryOwner): Promise<ProfileRow> {
    await this.load()
    const key = owner.key
    const cached = this.profileCache.get(key)
    if (cached) {
      cached.touchedAt = Date.now()
      return cached.value
    }
    const row = await readJson<ProfileRow | null>(this.ownerPath(owner, "profile"), null)
    const value = row || {
      [`${owner.type}Id`]: owner.id,
      profile: {},
      updatedAt: "",
    }
    return this.touchCache(this.profileCache, key, value, this.cacheLimit())
  }

  async saveProfile(owner: MemoryOwner, value: ProfileRow, opts: WriteOptions = {}): Promise<void> {
    this.touchCache(this.profileCache, owner.key, value, this.cacheLimit())
    this.dirtyProfiles.add(owner.key)
    if (opts.save === false) return
    this.scheduleFlush()
    if (opts.immediate) await this.flush()
  }

  async loadMemories(owner: MemoryOwner): Promise<MemoryRow[]> {
    await this.load()
    const key = owner.key
    const cached = this.memoryCache.get(key)
    if (cached) {
      cached.touchedAt = Date.now()
      return cached.value
    }
    const maxRows = Math.max(50, Number(memoryConfig().maxLoadedMemoriesPerOwner) || 600)
    const rows = await readJsonl<MemoryRow>(this.ownerPath(owner, "memory"), maxRows)
    const live = rows.filter(row => row && row.text && row.status !== "deleted")
    return this.touchCache(this.memoryCache, key, live, this.cacheLimit())
  }

  async saveMemories(owner: MemoryOwner, rows: MemoryRow[], opts: WriteOptions = {}): Promise<UnknownRecord> {
    const activeRows = this.normalizeMemoryWindow(rows)
    this.touchCache(this.memoryCache, owner.key, activeRows, this.cacheLimit())
    const file = this.ownerPath(owner, "memory")
    if (opts.save === false) return { compactedAt: "", storageVersion: 2, rows: activeRows }
    this.dirtyMemories.delete(owner.key)
    this.appendBuffers.delete(file)
    await writeTextAtomic(file, activeRows.map(lineJson).join(""))
    return { compactedAt: nowIso(), storageVersion: 2, rows: activeRows }
  }

  normalizeMemoryWindow(rows: readonly MemoryRow[] = []): MemoryRow[] {
    const maxRows = Math.max(50, Number(memoryConfig().maxMemoriesPerOwner) || 500)
    const next = [...rows]
      .filter(row => row && row.text && row.status !== "deleted" && row.status !== "archived")
      .map(row => ({ ...row, status: rollingStatus(row) }))
      .sort((a, b) => memoryRank(b) - memoryRank(a))
    return next.slice(0, maxRows)
  }

  async appendMemory(owner: MemoryOwner, row: MemoryRow, opts: WriteOptions = {}): Promise<void> {
    const file = this.ownerPath(owner, "memory")
    const lines = this.appendBuffers.get(file) || []
    lines.push(lineJson(row))
    this.appendBuffers.set(file, lines)
    const cached = this.memoryCache.get(owner.key)
    if (cached && !cached.value.some(item => item.id === row.id)) cached.value.push(row)
    const maxRows = Math.max(50, Number(memoryConfig().maxMemoriesPerOwner) || 500)
    if (cached && cached.value.length > maxRows) this.dirtyMemories.set(owner.key, owner)
    this.bumpStats({ memories: 1 })
    if (opts.save === false) return
    this.scheduleFlush()
    if (opts.immediate) await this.flush()
  }

  async appendEpisode(e: MemoryEvent, row: EpisodeRow): Promise<void> {
    const file = this.episodeFile(e)
    const lines = this.appendBuffers.get(file) || []
    lines.push(lineJson(row))
    this.appendBuffers.set(file, lines)
    this.scheduleFlush()
  }

  scheduleFlush(): void {
    const delay = Math.max(500, Number(memoryConfig().flushDelayMs) || 30000)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush().catch(err => hostRuntime.logger?.warn?.(`[Yui-Chat][Memory] flush failed: ${errorMessage(err)}`))
    }, delay)
    this.flushTimer.unref?.()
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise.then(async () => {
        if (this.pendingWriteCount()) await this.flush()
      })
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushPromise = this.flushPending().finally(() => {
      this.flushPromise = null
    })
    return this.flushPromise
  }

  async flushPending(): Promise<void> {
    try {
      await this.ensureDir()
      const profileEntries = [...this.dirtyProfiles]
      for (const key of profileEntries) {
        const entry = this.profileCache.get(key)
        if (!entry?.value) continue
        const owner: MemoryOwner = key.startsWith("group:") ? memoryOwner({ isGroup: true, group_id: key.slice(6) }, "group")
          : key.startsWith("scope:") ? { type: "scope", id: key.slice(6), key, dir: "scopes", file: safePart(key.slice(6)) }
            : memoryOwner({ user_id: key.slice(5) }, "user")
        this.dirtyProfiles.delete(key)
        try {
          await writeJsonAtomic(this.ownerPath(owner, "profile"), entry.value)
        } catch (err: unknown) {
          this.dirtyProfiles.add(key)
          throw err
        }
      }
      const memoryEntries = [...this.dirtyMemories.values()]
      for (const owner of memoryEntries) {
        const entry = this.memoryCache.get(owner.key)
        if (!entry?.value) continue
        this.dirtyMemories.delete(owner.key)
        try {
          await this.saveMemories(owner, entry.value)
        } catch (err: unknown) {
          this.dirtyMemories.set(owner.key, owner)
          throw err
        }
      }
      const buffers = [...this.appendBuffers.entries()].filter(([, lines]) => lines.length)
      for (const [file, lines] of buffers) {
        if (this.appendBuffers.get(file) === lines) this.appendBuffers.set(file, [])
      }
      const episodeFiles = []
      for (const [file, lines] of buffers) {
        try {
          await appendLines(file, lines)
        } catch (err: unknown) {
          const current = this.appendBuffers.get(file) || []
          this.appendBuffers.set(file, [...lines, ...current])
          throw err
        }
        if (!this.appendBuffers.get(file)?.length) this.appendBuffers.delete(file)
        if (path.dirname(file) === path.join(this.rootDir, "episodes")) episodeFiles.push(file)
      }
      for (const file of episodeFiles) {
        try {
          await this.compactEpisodeFile(file)
        } catch (err: unknown) {
          hostRuntime.logger?.warn?.(`[Yui-Chat][Memory] episode 收敛失败，将在后续写入时重试：${errorMessage(err)}`)
        }
      }
      await this.refreshStats({ cheap: true })
    } catch (err: unknown) {
      if (this.pendingWriteCount()) this.scheduleFlush()
      throw err
    }
  }

  async save(): Promise<void> {
    await this.flush()
  }

  bumpStats(delta: UnknownRecord = {}): void {
    this.lastStats = {
      ...this.lastStats,
      users: this.lastStats.users,
      memories: Math.max(0, (this.lastStats.memories || 0) + Number(delta.memories || 0)),
      pendingWrites: this.pendingWriteCount(),
    }
  }

  pendingWriteCount(): number {
    return this.dirtyProfiles.size + this.dirtyMemories.size + [...this.appendBuffers.values()].reduce((sum, lines) => sum + lines.length, 0)
  }

  async refreshStats(opts: UnknownRecord = {}): Promise<MemoryStats> {
    const countFiles = async (dir: string): Promise<number> => {
      try {
        return (await fs.readdir(dir, { withFileTypes: true })).filter(file => file.name.endsWith(".json") || file.name.endsWith(".jsonl")).length
      } catch {
        return 0
      }
    }
    const users = await countFiles(path.join(this.rootDir, "profiles", "users"))
    const groups = await countFiles(path.join(this.rootDir, "profiles", "groups"))
    const scopes = await countFiles(path.join(this.rootDir, "profiles", "scopes"))
    const memoryUsers = await countFiles(path.join(this.rootDir, "memories", "users"))
    const episodeFiles = await countFiles(path.join(this.rootDir, "episodes"))
    this.lastStats = {
      users: Math.max(users, memoryUsers, this.profileCache.size),
      groups,
      scopes,
      profiles: users + groups + scopes,
      memories: opts.cheap ? this.lastStats.memories || 0 : memoryUsers,
      episodeFiles,
      pendingWrites: this.pendingWriteCount(),
    }
    return this.lastStats
  }

  async appendInteraction(e: MemoryEvent, prompt: unknown, answer: unknown): Promise<void> {
    const config = memoryConfig()
    if (config.enabled !== true || config.autoWriteBack !== true) return
    await this.load()
    await this.appendEpisode(e, {
      id: crypto.randomUUID(),
      scope: scopeKey(e),
      userId: userKey(e),
      prompt: text(prompt).slice(0, 400),
      answer: text(answer).slice(0, 400),
      time: nowIso(),
    })

    // 文件降级模式也只记录可过期的互动，不从普通聊天推断长期事实。
    // 长期事实必须经 memory_manage 的显式意图校验或管理端人工编辑写入。
    this.scheduleFlush()
  }

  async addFact(e: MemoryEvent, fact: unknown, opts: WriteOptions = {}): Promise<MemoryRow | null> {
    const config = memoryConfig()
    await this.load()
    const clean = validateMemoryWrite(fact, { source: opts.source || "manual" }).slice(0, 240)
    if (!clean) return null
    const owner = memoryOwner(e, opts.owner || "user")
    const rows = await this.loadMemories(owner)
    const existing = rows.find(item => item.text === clean && item.status !== "deleted")
    const currentTime = nowIso()
    if (existing) {
      existing.updatedAt = currentTime
      existing.lastSeenAt = currentTime
      existing.confidence = Math.min(1, Number(existing.confidence || 0.7) + 0.04)
      existing.importance = Math.min(1, Number(existing.importance || 0.55) + 0.02)
      existing.status = rollingStatus(existing)
      await this.saveMemories(owner, rows, { save: opts.save })
      return existing
    }
    const row = {
      id: crypto.randomUUID(),
      scope: owner.key,
      ownerType: owner.type,
      ownerId: owner.id,
      type: text(opts.type || "fact"),
      text: clean,
      importance: Number(opts.importance ?? 0.62),
      confidence: Number(opts.confidence ?? 0.78),
      status: "active",
      createdAt: currentTime,
      updatedAt: currentTime,
      lastSeenAt: currentTime,
      lastUsedAt: "",
      hitCount: 0,
      tags: Array.isArray(opts.tags) ? opts.tags.map(item => text(item)).filter(Boolean).slice(0, 12) : [],
      sourceScope: scopeKey(e),
      source: opts.source || "manual",
    }
    const maxFacts = Math.max(5, Number(config.maxFactsPerUser) || 30)
    const activeCount = rows.filter(item => ACTIVE_STATUSES.has(item.status)).length
    if (activeCount >= maxFacts) {
      rows.sort((a, b) => memoryRank(a) - memoryRank(b))
      const demote = rows.find(item => ACTIVE_STATUSES.has(item.status))
      if (demote) demote.status = "cold"
    }
    rows.push(row)
    this.touchCache(this.memoryCache, owner.key, rows, this.cacheLimit())
    await this.appendMemory(owner, row, opts)
    return row
  }

  async getProfile(eOrUserId: MemoryEvent | string): Promise<ProfileResult> {
    const key = typeof eOrUserId === "object" ? userKey(eOrUserId) : String(eOrUserId || "unknown")
    const owner = memoryOwner({ user_id: key }, "user")
    const row = await this.loadProfile(owner)
    const facts = await this.listMemories({ user_id: key }, { owner: "user", limit: 50, includeCold: true })
    return {
      userId: key,
      profile: row.profile || {},
      facts,
      updatedAt: row.updatedAt,
    }
  }

  async listProfiles(opts: UnknownRecord = {}): Promise<UnknownRecord[]> {
    await this.load()
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50))
    const seen = new Set<string>()
    const userIds: string[] = []
    const collect = async (dir: string): Promise<void> => {
      try {
        for (const file of await fs.readdir(dir, { withFileTypes: true })) {
          if (!file.name.endsWith(".json") && !file.name.endsWith(".jsonl")) continue
          const userId = file.name.replace(/\.(json|jsonl)$/u, "")
          if (!seen.has(userId)) {
            seen.add(userId)
            userIds.push(userId)
          }
        }
      } catch { /* best-effort：失败不影响主流程。 */ }
    }
    await collect(path.join(this.rootDir, "profiles", "users"))
    await collect(path.join(this.rootDir, "memories", "users"))
    for (const key of this.profileCache.keys()) {
      if (!key.startsWith("user:")) continue
      const userId = key.slice(5)
      if (!seen.has(userId)) {
        seen.add(userId)
        userIds.push(userId)
      }
    }
    const rows: UnknownRecord[] = []
    for (const userId of userIds.slice(0, Math.max(limit * 3, limit))) {
      const result = await this.getProfile(userId)
      const facts = result.facts.slice(0, Number(opts.factLimit || 3))
      if (!Object.keys(result.profile).length && !facts.length) continue
      rows.push({
        userId,
        profile: result.profile,
        facts,
        factCount: result.facts.length,
        updatedAt: result.updatedAt || facts[0]?.updatedAt || facts[0]?.createdAt,
        summary: profileLines(result.profile),
      })
    }
    return rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit)
  }

  async listManagedScopes(opts: UnknownRecord = {}): Promise<UnknownRecord[]> {
    await this.load()
    const requestedType = managedScopeType(opts.scopeType)
    const query = String(opts.query || "").trim().toLowerCase()
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200))
    const targets: UnknownRecord[] = []
    const scopeTypes: ManagedScopeType[] = requestedType ? [requestedType] : ["user", "group"]
    for (const scopeType of scopeTypes) {
      const seen = new Set<string>()
      for (const kind of ["profiles", "memories"]) {
        const dir = path.join(this.rootDir, kind, scopeType === "user" ? "users" : "groups")
        try {
          for (const file of await fs.readdir(dir, { withFileTypes: true })) {
            if (!file.name.endsWith(".json") && !file.name.endsWith(".jsonl")) continue
            seen.add(file.name.replace(/\.(json|jsonl)$/u, ""))
          }
        } catch { /* 文件降级模式允许空目录。 */ }
      }
      const prefix = `${scopeType}:`
      for (const key of [...this.profileCache.keys(), ...this.memoryCache.keys()]) {
        if (key.startsWith(prefix)) seen.add(key.slice(prefix.length))
      }
      for (const rawId of seen) {
        const event = scopeType === "group" ? { isGroup: true, group_id: rawId, user_id: "web-admin" } : { isGroup: false, user_id: rawId }
        const owner = memoryOwner(event, scopeType === "group" ? "group" : "user")
        const items = await this.listMemories(event, { owner: scopeType === "group" ? "group" : "user", limit: 200, includeCold: true })
        const profile = scopeType === "user" ? (await this.getProfile(rawId)).profile : {}
        const label = `${rawId} ${String(profile.name || "")}`.toLowerCase()
        if (query && !label.includes(query)) continue
        const updatedAt = items.reduce((latest, item) => String(item.updatedAt || item.createdAt || "") > latest ? String(item.updatedAt || item.createdAt || "") : latest, "")
        targets.push({ scopeType, ownerId: owner.id, groupId: scopeType === "group" ? owner.id : "", memoryCount: items.length, profile, updatedAt })
      }
    }
    return targets.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, limit)
  }

  async getManagedScope(scopeType: unknown, ownerId: unknown): Promise<UnknownRecord> {
    await this.load()
    const type = managedScopeType(scopeType)
    const key = String(ownerId || "").trim()
    if (!type || !key) throw new Error("记忆范围和对象 ID 不能为空。")
    const event = type === "group" ? { isGroup: true, group_id: key, user_id: "web-admin" } : { isGroup: false, user_id: key }
    const items = await this.listMemories(event, { owner: type === "group" ? "group" : "user", limit: 200, includeCold: true })
    const profile = type === "user" ? (await this.getProfile(key)).profile : {}
    return { scopeType: type, ownerId: key, groupId: type === "group" ? key : "", profile, items }
  }

  async saveManagedMemory({ scopeType, ownerId, id, text: value, tags }: { scopeType?: unknown; ownerId?: unknown; id?: unknown; text?: unknown; tags?: unknown } = {}): Promise<MemoryRow | null> {
    await this.load()
    const type = managedScopeType(scopeType)
    const key = String(ownerId || "").trim()
    const clean = validateMemoryWrite(value, { source: "manual" }).slice(0, 240)
    if (!type || !key) throw new Error("记忆范围和对象 ID 不能为空。")
    if (!clean) throw new Error("记忆内容不能为空。")
    const event = type === "group" ? { isGroup: true, group_id: key, user_id: "web-admin" } : { isGroup: false, user_id: key }
    if (!id) return this.addFact(event, clean, { owner: type === "group" ? "group" : "user", source: "manual", tags, immediate: true })
    const owner = memoryOwner(event, type === "group" ? "group" : "user")
    const rows = await this.loadMemories(owner)
    const item = rows.find(row => row.id === String(id) && row.status !== "deleted")
    if (!item) throw new Error("未找到这条长期记忆。")
    item.text = clean
    item.tags = Array.isArray(tags) ? tags.map(tag => text(tag)).filter(Boolean).slice(0, 12) : item.tags
    item.updatedAt = nowIso()
    item.source = "manual-edit"
    await this.saveMemories(owner, rows, { immediate: true })
    return item
  }

  async deleteManagedMemory(scopeType: unknown, ownerId: unknown, memoryId: unknown): Promise<UnknownRecord> {
    await this.load()
    const type = managedScopeType(scopeType)
    const key = String(ownerId || "").trim()
    if (!type || !key) return { ok: false, id: memoryId }
    const event = type === "group" ? { isGroup: true, group_id: key, user_id: "web-admin" } : { isGroup: false, user_id: key }
    return this.forgetMemory(event, memoryId)
  }

  async setProfile(userId: unknown, patch: UnknownRecord = {}, opts: WriteOptions = {}): Promise<UnknownRecord> {
    const key = String(userId || "").trim()
    if (!key) throw new Error("缺少 userId。")
    const event = { user_id: key, isGroup: false }
    return this.updateProfile(event, patch, opts)
  }

  async updateProfile(e: MemoryEvent, patch: UnknownRecord = {}, opts: WriteOptions = {}): Promise<UnknownRecord> {
    const owner = memoryOwner(e, "user")
    const row = await this.loadProfile(owner)
    const normalized = normalizeProfilePatch(patch)
    const current: UnknownRecord = opts.replace ? {} : (row.profile || {})
    const merged: UnknownRecord = { ...current }
    for (const [field, value] of Object.entries(normalized)) {
      if (Array.isArray(value) && !opts.replace) {
        merged[field] = [...new Set([...(Array.isArray(current[field]) ? current[field] : []), ...value])].slice(0, 20)
      } else {
        merged[field] = value
      }
    }
    const updated = {
      userId: owner.id,
      profile: merged,
      updatedAt: nowIso(),
    }
    await this.saveProfile(owner, updated, opts)
    this.lastStats.profiles = Math.max(this.lastStats.profiles, this.profileCache.size)
    return this.getProfile(e)
  }

  async listMemories(e: MemoryEvent, opts: UnknownRecord = {}): Promise<MemoryRow[]> {
    const configuredOwners = Array.isArray(opts.owners) ? opts.owners.filter(isMemoryOwner) : []
    const owners: MemoryOwner[] = configuredOwners.length ? configuredOwners : [memoryOwner(e, ownerType(opts.owner))]
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 20))
    const includeCold = opts.includeCold === true
    const rows: MemoryRow[] = []
    for (const owner of owners) {
      const memories = await this.loadMemories(owner)
      for (const item of memories) {
        const status = rollingStatus(item)
        if (item.status === "deleted" || item.status === "archived") continue
        if (!includeCold && status === "cold") continue
        rows.push({ ...item, status })
      }
    }
    return rows.sort((a, b) => memoryRank(b) - memoryRank(a)).slice(0, limit)
  }

  async forgetMemory(e: MemoryEvent, id: unknown): Promise<UnknownRecord> {
    const cleanId = String(id || "").trim()
    if (!cleanId) throw new Error("缺少 memory id。")
    const owners = [memoryOwner(e, "user"), memoryOwner(e, "scope")]
    if (e.isGroup) owners.push(memoryOwner(e, "group"))
    for (const owner of owners) {
      const rows = await this.loadMemories(owner)
      const item = rows.find(row => row.id === cleanId)
      if (!item) continue
      item.status = "deleted"
      item.updatedAt = nowIso()
      await this.saveMemories(owner, rows, { immediate: true })
      return { ok: true, id: cleanId, text: item.text }
    }
    return { ok: false, id: cleanId }
  }

  async updateMemory(userId: unknown, id: unknown, patch: UnknownRecord = {}): Promise<MemoryRow> {
    const key = String(userId || "").trim()
    const cleanId = String(id || "").trim()
    const cleanText = validateMemoryWrite(patch.text, { source: "manual" }).slice(0, 240)
    if (!key || !cleanId) throw new Error("缺少用户或记忆 ID。")
    if (!cleanText) throw new Error("记忆内容不能为空。")
    const owner = memoryOwner({ user_id: key }, "user")
    const rows = await this.loadMemories(owner)
    const item = rows.find(row => row.id === cleanId && row.status !== "deleted")
    if (!item) throw new Error("未找到这条长期记忆。")
    item.text = cleanText
    item.tags = Array.isArray(patch.tags) ? patch.tags.map((value: unknown) => text(value)).filter(Boolean).slice(0, 12) : item.tags
    item.importance = Number(patch.importance ?? item.importance ?? 0.62)
    item.confidence = Number(patch.confidence ?? item.confidence ?? 0.78)
    item.updatedAt = nowIso()
    item.source = "manual-edit"
    await this.saveMemories(owner, rows, { immediate: true })
    return item
  }

  async search(e: MemoryEvent, query: unknown, limit = 5): Promise<UnknownRecord[]> {
    const tokens = tokenize(query)
    const owners = [memoryOwner(e, "user"), memoryOwner(e, "scope")]
    if (e.isGroup) owners.push(memoryOwner(e, "group"))
    const rows: UnknownRecord[] = []
    for (const owner of owners) {
      for (const memory of await this.loadMemories(owner)) {
        if (memory.status === "deleted" || memory.status === "archived") continue
        const status = rollingStatus(memory)
        const score = memoryRank({ ...memory, status }, tokens)
        if (!tokens.length || score > memoryRank(memory, [])) rows.push({ ...memory, status, score, resultType: "memory" })
      }
    }
    const episodes = await readJsonl<EpisodeRow>(this.episodeFile(e), Math.max(10, Number(memoryConfig().maxEpisodesPerScope) || 100))
    for (const episode of episodes) {
      const value = `${episode.prompt} -> ${episode.answer}`
      const score = tokens.reduce((sum, token) => sum + (value.toLowerCase().includes(token) ? token.length : 0), 0)
      if (score > 0) rows.push({ type: "episode", resultType: "episode", id: episode.id, text: value, time: episode.time, score })
    }
    return rows
      .filter(item => !tokens.length || Number(item.score) > 0)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 5)))
      .map(({ score, ...item }) => item)
  }

  async buildPrompt(e: MemoryEvent, query: unknown): Promise<string> {
    const config = memoryConfig()
    if (config.enabled !== true) return ""
    const parts: string[] = []
    if (config.injectProfile !== false) {
      const userProfile = await this.getProfile(e)
      const profile = profileLines(userProfile.profile)
      const facts = await this.listMemories(e, { limit: Math.max(3, Number(config.profileFactLimit) || 5) })
      if (profile.length) parts.push(`用户画像：\n${profile.map(item => `- ${item}`).join("\n")}`)
      if (facts.length) parts.push(`用户长期记忆：\n${facts.map(item => `- ${item.text}`).join("\n")}`)
    }
    if (config.injectRelevantFacts !== false) {
      const relevant = await this.search(e, query, Number(config.relevantLimit) || 5)
      if (relevant.length) {
        const currentTime = nowIso()
        const memoryHits = relevant.filter(item => item.resultType === "memory")
        for (const hit of memoryHits) {
          const owner: MemoryOwner = hit.ownerType === "group" ? memoryOwner({ isGroup: true, group_id: String(hit.ownerId || "") }, "group")
            : hit.ownerType === "scope" ? { type: "scope", id: String(hit.ownerId || ""), key: `scope:${String(hit.ownerId || "")}`, dir: "scopes", file: safePart(hit.ownerId) }
              : memoryOwner({ user_id: String(hit.ownerId || "") }, "user")
          const rows = await this.loadMemories(owner)
          const row = rows.find(item => item.id === hit.id)
          if (row) {
            row.lastUsedAt = currentTime
            row.hitCount = Number(row.hitCount || 0) + 1
            row.status = rollingStatus(row)
            this.dirtyMemories.set(owner.key, owner)
          }
        }
        if (this.dirtyMemories.size) this.scheduleFlush()
        parts.push(`与本轮相关的记忆：\n${relevant.map(item => `- ${item.text}`).join("\n")}`)
      }
    }
    const budget = Math.max(300, Number(config.promptBudgetChars) || 2200)
    return parts.join("\n\n").slice(0, budget)
  }

  stats() {
    return {
      ...this.lastStats,
      pendingWrites: this.pendingWriteCount(),
      storage: {
        format: "owner-files-v2",
        singleWriterOnly: true,
        profiles: "per-owner-json",
        memories: "per-owner-jsonl",
        episodes: "per-scope-jsonl",
        boundedTailRead: true,
      },
      cache: {
        profiles: this.profileCache.size,
        memories: this.memoryCache.size,
      },
    }
  }

  async resetForTest(rootDir = memoryDir) {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.flushPromise) await this.flushPromise.catch(() => {})
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.rootDir = rootDir
    this.data = { users: {}, scopes: {} }
    this.loaded = false
    this.profileCache.clear()
    this.memoryCache.clear()
    this.appendBuffers.clear()
    this.dirtyProfiles.clear()
    this.dirtyMemories.clear()
    this.flushPromise = null
    this.lastStats = { users: 0, groups: 0, scopes: 0, profiles: 0, memories: 0, episodeFiles: 0, pendingWrites: 0 }
  }
}

export const fileMemoryStore = new MemoryStore()
// 仅供 SQLite 不可用时的兼容回退；新调用方应从 memory/store.js 获取门面。
export const memoryStore = fileMemoryStore
export { profileLines, scopeKey, userKey }
