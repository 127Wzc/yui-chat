import crypto from "node:crypto"
import { sqliteClient } from "../core/storage/sqlite/client.js"

type UnknownRecord = Record<string, unknown>
type DistanceMetric = "cosine" | "l2" | "l1"

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
  if (!["cosine", "l2", "l1"].includes(metric)) throw new Error("向量距离算法无效，仅支持 cosine、l2、l1")
  return metric as DistanceMetric
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

  async search(space: VectorSpace | null, vector: readonly number[], limit = 30): Promise<VectorMatch[]> {
    if (!space || !sqliteClient.status.vector?.available) return []
    const resultLimit = Math.max(1, Math.min(1000, Number(limit) || 30))
    normalizeDistanceMetric(space.distanceMetric)
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
