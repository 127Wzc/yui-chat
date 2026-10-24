import crypto from "node:crypto"
import { sqliteClient } from "../core/storage/sqlite/client.js"

type UnknownRecord = Record<string, unknown>
type DistanceMetric = "cosine"

export interface VectorSpace {
  id: string
  table: string
  dimensions: number
  modelName: string
  distanceMetric: DistanceMetric
  scopeKey: string
}

interface VectorItem {
  ownerType: string
  ownerId: string
  contentHash: string
  vector: readonly number[]
}

export interface VectorMatch {
  id: string
  ownerType: string
  ownerId: string
  distance: number
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function safeTable(spaceId: unknown): string { return `vec_${String(spaceId).replace(/[^a-z0-9]/gi, "").slice(0, 40)}` }
function normalizeDimensions(value: unknown): number {
  const dimensions = Number(value)
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536) throw new Error("向量维度无效")
  return dimensions
}
export function normalizeDistanceMetric(value: unknown = "cosine"): DistanceMetric {
  const metric = String(value || "cosine").trim().toLowerCase()
  if (metric !== "cosine") throw new Error("向量检索统一使用 cosine，不支持其他距离算法")
  return "cosine"
}
export function vectorSpaceMatches(space: unknown, { modelName, dimensions, distanceMetric = "cosine" }: { modelName?: unknown; dimensions?: unknown; distanceMetric?: unknown } = {}): boolean {
  if (!space) return false
  try {
    const value = record(space)
    return String(value.modelName || "") === String(modelName || "")
      && Number(value.dimensions) === normalizeDimensions(dimensions)
      && normalizeDistanceMetric(value.distanceMetric) === normalizeDistanceMetric(distanceMetric)
  } catch {
    return false
  }
}
function spaceId(modelName: unknown, dimensions: number, metric: DistanceMetric, scopeKey = ""): string {
  return crypto.createHash("sha256").update(`${modelName}:${dimensions}:${metric}:${scopeKey}`).digest("hex").slice(0, 32)
}

export class VectorIndex {
  spaceIdFor({ modelName, dimensions, distanceMetric = "cosine", scopeKey = "" }: { modelName?: unknown; dimensions: unknown; distanceMetric?: unknown; scopeKey?: string }): string {
    return spaceId(modelName, normalizeDimensions(dimensions), normalizeDistanceMetric(distanceMetric), scopeKey)
  }

  async ensureSpace({ modelName, dimensions, distanceMetric = "cosine", scopeKey = "" }: { modelName?: unknown; dimensions: unknown; distanceMetric?: unknown; scopeKey?: string }): Promise<VectorSpace | null> {
    if (!sqliteClient.status.vector?.available || !modelName) return null
    const normalizedDimensions = normalizeDimensions(dimensions)
    const normalizedMetric = normalizeDistanceMetric(distanceMetric)
    const id = this.spaceIdFor({ modelName, dimensions: normalizedDimensions, distanceMetric: normalizedMetric, scopeKey })
    await sqliteClient.run(
      "INSERT INTO embedding_spaces(id, model_name, dimensions, distance_metric, scope_key) VALUES(?, ?, ?, ?, ?) ON CONFLICT(model_name, dimensions, distance_metric, scope_key) DO NOTHING",
      [id, modelName, normalizedDimensions, normalizedMetric, scopeKey],
      "vectors",
    )
    const table = safeTable(id)
    await sqliteClient.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${normalizedDimensions}] distance_metric=${normalizedMetric}, +record_id TEXT)`, "vectors")
    return { id, table, dimensions: normalizedDimensions, modelName: String(modelName), distanceMetric: normalizedMetric, scopeKey: String(scopeKey) }
  }

  // 全量空间清单只服务孤儿回收：调用方按 scope_key 判定归属，这里不做过滤。
  async listSpaces(): Promise<Array<{ id: string; scopeKey: string }>> {
    if (!sqliteClient.status.vector?.available) return []
    const rows = await sqliteClient.all("SELECT id, scope_key FROM embedding_spaces", [], "vectors")
    return rows.map(row => ({ id: String(row.id || ""), scopeKey: String(row.scope_key || "") }))
  }

  async getSpace(spaceIdValue: unknown): Promise<VectorSpace | null> {
    if (!sqliteClient.status.vector?.available || !spaceIdValue) return null
    const row = await sqliteClient.get("SELECT * FROM embedding_spaces WHERE id=?", [spaceIdValue], "vectors")
    // 旧度量空间只能回收，不能伪装成 cosine 空间继续查询或复制。
    if (row && row.distance_metric !== "cosine") return null
    if (row && !await sqliteClient.get("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?", [safeTable(row.id)], "vectors")) return null
    return row ? {
      id: String(row.id || ""),
      table: safeTable(row.id),
      modelName: String(row.model_name || ""),
      dimensions: Number(row.dimensions),
      distanceMetric: normalizeDistanceMetric(row.distance_metric),
      scopeKey: String(row.scope_key || ""),
    } : null
  }

  async upsert(space: VectorSpace | null, { ownerType, ownerId, contentHash, vector }: VectorItem): Promise<boolean> {
    return (await this.upsertBatch(space, [{ ownerType, ownerId, contentHash, vector }])) > 0
  }

  async upsertBatch(space: VectorSpace | null, items: unknown[] = []): Promise<number> {
    if (!space || !sqliteClient.status.vector?.available) return 0
    normalizeDistanceMetric(space.distanceMetric)
    const records = items.filter((item): item is VectorItem => {
      const value = record(item)
      return Boolean(value.ownerType && value.ownerId && Array.isArray(value.vector))
    })
    if (!records.length) return 0
    const grouped = new Map<string, Map<string, VectorItem>>()
    for (const record of records) {
      const group = grouped.get(record.ownerType) || new Map<string, VectorItem>()
      group.set(String(record.ownerId), record)
      grouped.set(record.ownerType, group)
    }
    let written = 0
    for (const [ownerType, byOwner] of grouped) {
      const group = [...byOwner.values()]
      const ownerIds = [...byOwner.keys()]
      const existingRows = await sqliteClient.all(
        `SELECT id, owner_id, content_hash FROM embedding_records WHERE space_id=? AND owner_type=? AND owner_id IN (${ownerIds.map(() => "?").join(",")})`,
        [space.id, ownerType, ...ownerIds],
        "vectors",
      )
      const existingByOwner = new Map(existingRows.map(row => [String(row.owner_id || ""), row]))
      const existingIds = existingRows.map(row => String(row.id || ""))
      const indexed = existingIds.length
        ? await sqliteClient.all(`SELECT record_id FROM ${space.table} WHERE record_id IN (${existingIds.map(() => "?").join(",")})`, existingIds, "vectors")
        : []
      const indexedIds = new Set(indexed.map(row => String(row.record_id || "")))
      const pending = group.filter(item => {
        const existing = existingByOwner.get(String(item.ownerId))
        return !existing || String(existing.content_hash || "") !== item.contentHash || !indexedIds.has(String(existing.id || ""))
      })
      if (!pending.length) continue
      const operations = []
      for (const item of pending) {
        const existing = existingByOwner.get(String(item.ownerId))
        const recordId = String(existing?.id || crypto.randomUUID())
        operations.push(
          { sql: `DELETE FROM ${space.table} WHERE record_id=?`, params: [recordId] },
          { sql: "INSERT INTO embedding_records(id, space_id, owner_type, owner_id, content_hash) VALUES(?, ?, ?, ?, ?) ON CONFLICT(space_id, owner_type, owner_id) DO UPDATE SET content_hash=excluded.content_hash", params: [recordId, space.id, ownerType, String(item.ownerId), String(item.contentHash || "")] },
          { sql: `INSERT INTO ${space.table}(embedding, record_id) VALUES(?, ?)`, params: [JSON.stringify(item.vector), recordId] },
        )
      }
      await sqliteClient.transaction(operations, "vectors")
      written += pending.length
    }
    return written
  }

  /** 只认可元数据和 vec0 中实际向量同时存在的条目，用于状态检查与断点续传。 */
  async indexedContentHashes(space: VectorSpace | null, ownerType: string, ownerIds: string[]): Promise<Map<string, string>> {
    const hashes = new Map<string, string>()
    if (!space || !sqliteClient.status.vector?.available) return hashes
    for (let offset = 0; offset < ownerIds.length; offset += 400) {
      const batch = ownerIds.slice(offset, offset + 400)
      const rows = await sqliteClient.all(
        `SELECT r.owner_id, r.content_hash FROM embedding_records r JOIN ${space.table} v ON v.record_id=r.id
         WHERE r.space_id=? AND r.owner_type=? AND r.owner_id IN (${batch.map(() => "?").join(",")})`,
        [space.id, ownerType, ...batch], "vectors",
      )
      for (const row of rows) hashes.set(String(row.owner_id), String(row.content_hash))
    }
    return hashes
  }

  /** 从相同模型空间按内容摘要复制真实向量；新 chunk ID 也可复用。 */
  async copyMatching(source: VectorSpace | null, target: VectorSpace, chunks: Array<{ id?: unknown; content_hash?: unknown }>): Promise<number> {
    if (!source || source.id === target.id || !vectorSpaceMatches(source, target) || !chunks.length) return 0
    const hashes = [...new Set(chunks.map(item => String(item.content_hash || "")))]
    const rows = await sqliteClient.all<UnknownRecord>(
      `SELECT r.content_hash, vec_to_json(v.embedding) AS vector FROM embedding_records r JOIN ${source.table} v ON v.record_id=r.id WHERE r.space_id=? AND r.owner_type='knowledge_chunk' AND r.content_hash IN (${hashes.map(() => "?").join(",")})`,
      [source.id, ...hashes], "vectors",
    )
    const byHash = new Map(rows.map(row => [String(row.content_hash), String(row.vector)]))
    const items = chunks.filter(item => byHash.has(String(item.content_hash))).map(item => ({ ownerType: "knowledge_chunk", ownerId: String(item.id), contentHash: String(item.content_hash), vector: JSON.parse(byHash.get(String(item.content_hash))!) as number[] }))
    return this.upsertBatch(target, items)
  }

  async search(space: VectorSpace | null, vector: readonly number[], limit = 30, filter?: { ownerType: string; ownerIds: string[] }): Promise<VectorMatch[]> {
    if (!space || !sqliteClient.status.vector?.available) return []
    const resultLimit = Math.max(1, Math.min(1000, Number(limit) || 30))
    normalizeDistanceMetric(space.distanceMetric)
    if (filter) {
      // 每批先解析允许的 rowid，再由 vec0 在该集合内取近邻；空集合绝不退回全局搜索。
      // 各批 top-k 的并集包含全体 top-k，分批只限制 SQL 参数量，不截断召回范围。
      const ownerIds = [...new Set(filter.ownerIds)]
      const matches: VectorMatch[] = []
      for (let offset = 0; offset < ownerIds.length; offset += 400) {
        const batch = ownerIds.slice(offset, offset + 400)
        const rows = await sqliteClient.all(
          `SELECT record_id, distance FROM ${space.table} WHERE embedding MATCH ? AND k=? AND rowid IN (
            SELECT v.rowid FROM ${space.table} v JOIN embedding_records r ON r.id=v.record_id
            WHERE r.space_id=? AND r.owner_type=? AND r.owner_id IN (${batch.map(() => "?").join(",")})
          )`, [JSON.stringify(vector), resultLimit, space.id, filter.ownerType, ...batch], "vectors",
        )
        const ids = rows.map(row => String(row.record_id))
        if (!ids.length) continue
        const records = await sqliteClient.all(`SELECT id, owner_id FROM embedding_records WHERE space_id=? AND owner_type=? AND id IN (${ids.map(() => "?").join(",")})`, [space.id, filter.ownerType, ...ids], "vectors")
        const byId = new Map(records.map(row => [String(row.id), String(row.owner_id)]))
        for (const row of rows) {
          const id = String(row.record_id)
          const ownerId = byId.get(id)
          if (ownerId) matches.push({ id, ownerType: filter.ownerType, ownerId, distance: Number(row.distance) })
        }
        matches.sort((a, b) => a.distance - b.distance || a.ownerId.localeCompare(b.ownerId))
        matches.length = Math.min(matches.length, resultLimit)
      }
      return matches
    }
    const rows = await sqliteClient.all(`SELECT record_id, distance FROM ${space.table} WHERE embedding MATCH ? AND k = ?`, [JSON.stringify(vector), resultLimit], "vectors")
    if (!rows.length) return []
    const ids = rows.map(row => String(row.record_id || ""))
    const records = await sqliteClient.all(`SELECT id, owner_type, owner_id FROM embedding_records WHERE id IN (${ids.map(() => "?").join(",")})`, ids, "vectors")
    const byId = new Map(records.map(row => [String(row.id || ""), row]))
    return rows.map(row => {
      const value = byId.get(String(row.record_id || ""))
      return value ? { id: String(value.id || ""), ownerType: String(value.owner_type || ""), ownerId: String(value.owner_id || ""), distance: Number(row.distance) } : null
    }).filter((value): value is VectorMatch => value !== null)
  }

  async deleteOwners(ownerType: unknown, ownerIds: unknown[] = []): Promise<number> {
    if (!sqliteClient.status.vector?.available) return 0
    const unique = [...new Set(ownerIds.map(String).filter(Boolean))]
    if (!unique.length) return 0
    const records = await sqliteClient.all(
      `SELECT id, space_id FROM embedding_records WHERE owner_type=? AND owner_id IN (${unique.map(() => "?").join(",")})`,
      [ownerType, ...unique],
      "vectors",
    )
    const bySpace = new Map<string, string[]>()
    for (const value of records) {
      const spaceIdValue = String(value.space_id || "")
      bySpace.set(spaceIdValue, [...(bySpace.get(spaceIdValue) || []), String(value.id || "")])
    }
    for (const [spaceIdValue, recordIds] of bySpace) {
      const table = safeTable(spaceIdValue)
      await sqliteClient.transaction([
        ...recordIds.map(recordId => ({ sql: `DELETE FROM ${table} WHERE record_id=?`, params: [recordId] })),
        { sql: `DELETE FROM embedding_records WHERE id IN (${recordIds.map(() => "?").join(",")})`, params: recordIds },
      ], "vectors")
    }
    return records.length
  }

  async deleteSpace(spaceIdValue: unknown): Promise<boolean> {
    if (!sqliteClient.status.vector?.available || !spaceIdValue) return false
    const exists = await sqliteClient.get("SELECT id FROM embedding_spaces WHERE id=?", [spaceIdValue], "vectors")
    if (!exists) return false
    const table = safeTable(spaceIdValue)
    await sqliteClient.transaction([
      { sql: `DROP TABLE IF EXISTS ${table}`, params: [] },
      { sql: "DELETE FROM embedding_spaces WHERE id=?", params: [spaceIdValue] },
    ], "vectors")
    return true
  }
}

export const vectorIndex = new VectorIndex()
