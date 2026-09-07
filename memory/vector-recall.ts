import crypto from "node:crypto"
import { configStore } from "../config/store.js"
import { modelLogStore } from "../core/observability/model-log.js"
import { hostRuntime } from "../core/runtime/host-runtime.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { vectorIndex } from "../knowledge/vector-index.js"
import type { VectorMatch, VectorSpace } from "../knowledge/vector-index.js"
import { resolveEmbeddingDimensions } from "../models/embeddings/dimensions.js"
import { embeddingRunner } from "../models/embeddings/runner.js"

const OWNER_TYPE = "memory_item"
const SPACE_SCOPE_KEY = "memory-items"
const SYNC_DEBOUNCE_MS = 5000
const FAIL_COOLDOWN_MS = 10 * 60 * 1000
const FAIL_STREAK_LIMIT = 3
const QUERY_CACHE_LIMIT = 128
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000
const MIN_QUERY_CHARS = 4
const MIN_VECTOR_SCORE = 0.35

type UnknownRecord = Record<string, unknown>

interface MemoryScope extends UnknownRecord {
  scopeType: string
  ownerId: string
  groupId?: string
}

interface QueryCacheEntry {
  vector: number[]
  expiresAt: number
}

interface EmbedQueryOptions {
  modelName: string
  dimensions: number
  normalized: string
  query: unknown
  event?: unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

// 错误信息会进入诊断（stats.lastError）和日志，按凭证边界先脱敏再截断。
function errorMessage(error: unknown): string {
  return String(record(error).message || error || "")
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi, "$1<redacted>")
    .slice(0, 300)
}

const parseTags = (value: unknown): unknown[] => { try { return value ? JSON.parse(String(value)) as unknown[] : [] } catch { return [] } }
const sha256 = (value: unknown): string => crypto.createHash("sha256").update(String(value)).digest("hex")

// 记忆向量召回增强层：默认关闭（memory.retrieval.embeddingModel 留空），
// 开启后把可召回记忆（fact + 提炼 episode）同步进 vec0 索引，供 retrieval.js 在 FTS 之外补语义候选。
// 单向依赖约束：repository/sqlite-store → 本模块 → sqliteClient/vectorIndex/embeddingRunner/modelLogStore/configStore。
export class MemoryVectorRecall {
  syncing = false
  dirtyTimer: ReturnType<typeof setTimeout> | null = null
  failUntil = 0
  failureStreak = 0
  indexed = 0
  lastSyncAt = 0
  lastError = ""
  queryCache = new Map<string, QueryCacheEntry>()
  space: VectorSpace | null = null
  spaceKey = ""

  retrievalConfig(): UnknownRecord {
    return record(record(record(configStore.get()).memory).retrieval)
  }

  enabled(): boolean {
    return Boolean(String(this.retrievalConfig().embeddingModel || "").trim()) && Boolean(sqliteClient.status.vector?.available)
  }

  // 空间随模型/维度配置变化重建句柄；ensureSpace 本身幂等，这里只是避免每次召回都跑 DDL。
  async ensureSpace(): Promise<{ space: VectorSpace | null; modelName: string; dimensions: number }> {
    const config = record(configStore.get())
    const retrieval = this.retrievalConfig()
    const modelName = String(retrieval.embeddingModel || "").trim()
    const models = Array.isArray(config.models) ? config.models.map(record) : []
    const model = models.find(item => String(item.name || "") === modelName) || {}
    const dimensions = resolveEmbeddingDimensions(model, Number(retrieval.embeddingDimensions || 0))
    const key = `${modelName}:${dimensions}`
    if (!this.space || this.spaceKey !== key) {
      const space = await vectorIndex.ensureSpace({ modelName, dimensions, distanceMetric: "cosine", scopeKey: SPACE_SCOPE_KEY })
      if (!space) return { space: null, modelName, dimensions }
      this.space = space
      this.spaceKey = key
    }
    return { space: this.space, modelName, dimensions }
  }

  // 写入方（memory/repository.js、sqlite-store.js）在数据变化后调用；5 秒去抖合并一批写入，
  // 熔断期内静默跳过，避免每条写入都追打一次失败的 embedding API。
  markDirty() {
    if (!this.enabled() || Date.now() < this.failUntil || this.dirtyTimer) return
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null
      void this.syncMemoryVectors()
    }, SYNC_DEBOUNCE_MS)
    this.dirtyTimer.unref?.()
  }

  // 把可召回记忆与 embedding_records 按 contentHash 对齐：新增/变更行重嵌入，
  // 已不满足条件（归档/删除/过期/停写类型）的 owner 清掉向量。错误全部内部消化，不影响业务链路。
  async syncMemoryVectors(): Promise<void> {
    if (this.syncing || !this.enabled() || Date.now() < this.failUntil) return
    this.syncing = true
    let trace = null
    try {
      const { space, modelName, dimensions } = await this.ensureSpace()
      if (!space) return
      const rows = await sqliteClient.all<UnknownRecord>(
        `SELECT id, text FROM memory_items
         WHERE status IN ('active','warm','cold') AND type IN ('fact','episode')
           AND NOT (type='episode' AND source='interaction')
           AND TRIM(text) != '' AND (expires_at = 0 OR expires_at > ?)`,
        [Date.now()],
      )
      const records = await sqliteClient.all<UnknownRecord>(
        "SELECT owner_id, content_hash FROM embedding_records WHERE space_id=? AND owner_type=?",
        [space.id, OWNER_TYPE],
        "vectors",
      )
      const eligible = new Map(rows.map(row => [String(row.id || ""), { id: String(row.id || ""), text: String(row.text || ""), hash: sha256(row.text) }]))
      const recorded = new Map(records.map(row => [String(row.owner_id || ""), String(row.content_hash || "")]))
      const pending = [...eligible.values()].filter(item => recorded.get(item.id) !== item.hash)
      const stale = [...recorded.keys()].filter(ownerId => !eligible.has(ownerId))
      if (stale.length) await vectorIndex.deleteOwners(OWNER_TYPE, stale)
      if (pending.length) {
        // 无待办时不建 trace、不调 API；有待办时整批进大模型日志（参考 knowledge/index-jobs.js）。
        trace = modelLogStore.createTrace({
          source: "memory-vector-index",
          purpose: "embedding_memory",
          metadata: { task: "memory-vector-index", pending: pending.length, stale: stale.length },
        })
        const embedded = await embeddingRunner.embedTexts({
          modelName,
          texts: pending.map(item => item.text),
          dimensions,
          purpose: "embedding_memory",
          source: "memory-vector-index",
          taskName: "memory-vector-index",
          trace,
        })
        for (const [index, item] of pending.entries()) {
          await vectorIndex.upsert(space, { ownerType: OWNER_TYPE, ownerId: item.id, contentHash: item.hash, vector: embedded.vectors[index] })
        }
        modelLogStore.finishTrace(trace, { status: "ok", metadata: { indexed: pending.length, stale: stale.length, modelName } })
        trace = null
      }
      this.indexed = eligible.size
      this.lastSyncAt = Date.now()
      this.lastError = ""
      this.failureStreak = 0
    } catch (error: unknown) {
      if (trace) modelLogStore.finishTrace(trace, { status: "error", error })
      this.lastError = errorMessage(error)
      this.failureStreak += 1
      if (record(error).code === "BUDGET_EXHAUSTED" || this.failureStreak >= FAIL_STREAK_LIMIT) {
        this.failUntil = Date.now() + FAIL_COOLDOWN_MS
        this.failureStreak = 0
      }
      hostRuntime.logger?.warn?.(`[yui-chat] 记忆向量索引同步失败：${this.lastError}`)
    } finally {
      this.syncing = false
    }
  }

  // 查询 embedding 三道节约门槛：
  // 1) 归一后有效字符 < 4 直接放弃（太短的查询语义太弱，不值得调 API）；
  // 2) 5 分钟 TTL + LRU 128 的内存缓存，命中不调 API、不建 trace；
  // 3) 真实调用才建 memory-recall trace 并成对 finishTrace——按要求进大模型日志。
  async embedQuery({ modelName, dimensions, normalized, query, event }: EmbedQueryOptions): Promise<number[] | null> {
    const key = `${modelName}:${dimensions}:${normalized.toLowerCase()}`
    const cached = this.queryCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      this.queryCache.delete(key)
      this.queryCache.set(key, cached)
      return cached.vector
    }
    const trace = modelLogStore.createTrace({ event, source: "memory-recall", purpose: "embedding_memory", metadata: { task: "memory-recall" } })
    let embedded
    try {
      embedded = await embeddingRunner.embedTexts({
        modelName,
        texts: [String(query)],
        dimensions,
        purpose: "embedding_memory",
        source: "memory-recall",
        taskName: "memory-recall",
        trace,
        event,
      })
      modelLogStore.finishTrace(trace, { status: "ok", metadata: { modelName } })
    } catch (error) {
      modelLogStore.finishTrace(trace, { status: "error", error })
      throw error
    }
    const vector = embedded.vectors[0]
    if (!vector) return null
    this.queryCache.set(key, { vector, expiresAt: Date.now() + QUERY_CACHE_TTL_MS })
    while (this.queryCache.size > QUERY_CACHE_LIMIT) {
      const oldest = this.queryCache.keys().next().value
      if (typeof oldest !== "string") break
      this.queryCache.delete(oldest)
    }
    return vector
  }

  // 语义召回候选：返回形状与 memoryRepository.list 一致（原始行 + tags），并附 score = max(0, 1 - distance)。
  // 任何错误都降级为空数组，由 retrieval.js 继续走 FTS 结果。
  async queryMemoryVectors(scopes: MemoryScope[] = [], query: unknown = "", { event = null }: { event?: unknown } = {}): Promise<UnknownRecord[]> {
    if (!scopes.length || !this.enabled() || Date.now() < this.failUntil) return []
    try {
      const normalized = String(query).replace(/\s+/g, "")
      if ([...normalized].length < MIN_QUERY_CHARS) return []
      const { space, modelName, dimensions } = await this.ensureSpace()
      if (!space) return []
      const vector = await this.embedQuery({ modelName, dimensions, normalized, query, event })
      if (!vector) return []
      const limit = Math.max(1, Number(this.retrievalConfig().vectorCandidateLimit) || 20)
      // 向量空间由所有记忆共用：适度多取后再按本轮作用域过滤，降低目标成员被全局近邻挤出的概率。
      const searchLimit = Math.min(1000, Math.max(limit, limit * Math.min(5, Math.max(1, scopes.length))))
      const owners: VectorMatch[] = (await vectorIndex.search(space, vector, searchLimit))
        .filter(item => item.ownerType === OWNER_TYPE && Math.max(0, 1 - Number(item.distance)) >= MIN_VECTOR_SCORE)
      if (!owners.length) return []
      const ids = [...new Set(owners.map(item => String(item.ownerId)))]
      const rows = await sqliteClient.all<UnknownRecord>(`SELECT * FROM memory_items WHERE id IN (${ids.map(() => "?").join(",")})`, ids)
      const byId = new Map(rows.map(row => [String(row.id || ""), row]))
      const scopeKeys = new Set(scopes.map(scope => `${scope.scopeType}|${scope.ownerId}|${scope.groupId || ""}`))
      const now = Date.now()
      const results: UnknownRecord[] = []
      for (const owner of owners) {
        const row = byId.get(String(owner.ownerId))
        if (!row) continue
        if (!scopeKeys.has(`${row.scope_type}|${row.owner_id}|${row.group_id || ""}`)) continue
        if (!["active", "warm", "cold"].includes(String(row.status || ""))) continue
        if (Number(row.expires_at || 0) > 0 && Number(row.expires_at) <= now) continue
        if (row.type === "profile" || row.type === "short") continue
        if (row.type === "episode" && row.source === "interaction") continue
        results.push({ ...row, tags: parseTags(row.tags_json), score: Math.max(0, 1 - Number(owner.distance)) })
        if (results.length >= limit) break
      }
      return results
    } catch (error: unknown) {
      const message = errorMessage(error)
      if (record(error).code === "BUDGET_EXHAUSTED") this.failUntil = Date.now() + FAIL_COOLDOWN_MS
      if (message !== this.lastError) hostRuntime.logger?.warn?.(`[yui-chat] 记忆向量召回失败，本轮已降级为纯 FTS：${message}`)
      this.lastError = message
      return []
    }
  }

  // 供 retrieval.js 在补向量前短路：这些 scope 若没有任何可召回记忆，就不必为查询付一次 embedding。
  async hasAnyMemory(scopes: MemoryScope[] = []): Promise<boolean> {
    if (!scopes.length) return false
    try {
      const conditions = scopes.map(() => "(scope_type=? AND owner_id=? AND group_id=?)").join(" OR ")
      const params = scopes.flatMap(scope => [scope.scopeType, scope.ownerId, scope.groupId || ""])
      const row = await sqliteClient.get<UnknownRecord>(
        `SELECT COUNT(*) AS count FROM memory_items
         WHERE (${conditions}) AND status IN ('active','warm','cold')
           AND type NOT IN ('profile','short') AND NOT (type='episode' AND source='interaction')
           AND (expires_at = 0 OR expires_at > ?)`,
        [...params, Date.now()],
      )
      return Number(row?.count || 0) > 0
    } catch (error: unknown) {
      // 预检失败按“无记忆”处理：跳过向量召回本身就是安全降级，不值得让整次检索失败。
      hostRuntime.logger?.debug?.("[yui-chat] 记忆向量召回预检失败，跳过向量补充", error)
      return false
    }
  }

  stats(): UnknownRecord {
    return {
      enabled: this.enabled(),
      indexed: this.indexed,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      cachedQueries: this.queryCache.size,
    }
  }
}

export const vectorRecall = new MemoryVectorRecall()
