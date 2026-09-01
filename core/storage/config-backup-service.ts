import path from "node:path"
import { configStore } from "../../config/store.js"
import { capabilityStore } from "../../tools/access/capability-store.js"
import { sqliteClient } from "./sqlite/client.js"
import type { SqliteOperation } from "./types.js"

const SQLITE_CONFIG_VERSION = 2
const MAX_ROWS_PER_DOMAIN = 50000
type UnknownRecord = Record<string, unknown>
type SnapshotTables = Record<string, UnknownRecord[]>

export interface SqliteConfigSnapshot {
  version: number
  available: boolean
  tables: SnapshotTables
}

const snapshotQueries: Record<string, string> = {
  capabilityRules: "SELECT id, subject_type, subject_id, group_id, resource_type, resource_id, effect, created_at, updated_at FROM capability_rules ORDER BY id",
  knowledgeBases: "SELECT id, name, description, embedding_model_name, embedding_dimensions, distance_metric, chunk_strategy_json, retrieval_json, protected, created_at, updated_at FROM knowledge_bases ORDER BY id",
  knowledgeGrants: "SELECT id, knowledge_base_id, subject_type, subject_id, group_id, effect, created_at, updated_at FROM knowledge_grants ORDER BY id",
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function rowsOf(tables: UnknownRecord, key: string): UnknownRecord[] | null {
  const rows = tables?.[key]
  if (!Array.isArray(rows)) return null
  if (rows.length > MAX_ROWS_PER_DOMAIN) throw new Error(`备份中的 SQLite 配置项过多：${key}`)
  return rows
}

function text(value: unknown): string { return String(value ?? "") }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }

export async function snapshotSqliteConfig(): Promise<SqliteConfigSnapshot> {
  if (!sqliteClient.status.available) return { version: SQLITE_CONFIG_VERSION, available: false, tables: {} }
  // 三张表在同一个读事务中取快照，避免备份期间的并发写造成表间引用不一致。
  const keys = Object.keys(snapshotQueries)
  const results = await sqliteClient.transaction(keys.map(key => ({ sql: snapshotQueries[key], params: [], mode: "all" })))
  const tables = Object.fromEntries(keys.map((key, index) => [key, Array.isArray(results[index]) ? results[index] as UnknownRecord[] : []])) as SnapshotTables
  return { version: SQLITE_CONFIG_VERSION, available: true, tables }
}

export async function restoreSqliteConfig(
  snapshot: SqliteConfigSnapshot,
  { pruneMissingBases = false }: { pruneMissingBases?: boolean } = {},
): Promise<{ restored: boolean; reason?: string; counts: Record<string, number> }> {
  if (!snapshot?.available) return { restored: false, reason: "snapshot-unavailable", counts: {} }
  if (!sqliteClient.status.available) throw new Error("SQLite 不可用，无法恢复备份中的配置项")
  if (Number(snapshot.version) !== SQLITE_CONFIG_VERSION) throw new Error(`不支持的 SQLite 配置备份版本：${snapshot.version}`)
  const tables = record(snapshot.tables)
  const operations: SqliteOperation[] = []
  const counts: Record<string, number> = {}

  const capabilityRules = rowsOf(tables, "capabilityRules")
  if (capabilityRules) {
    counts.capabilityRules = capabilityRules.length
    operations.push({ sql: "DELETE FROM capability_rules", params: [] })
    for (const row of capabilityRules) operations.push({
      sql: "INSERT INTO capability_rules(id, subject_type, subject_id, group_id, resource_type, resource_id, effect, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params: [text(row.id), text(row.subject_type), text(row.subject_id), text(row.group_id), text(row.resource_type), text(row.resource_id), text(row.effect), number(row.created_at), number(row.updated_at)],
    })
  }

  const knowledgeBases = rowsOf(tables, "knowledgeBases")
  if (knowledgeBases) {
    counts.knowledgeBases = knowledgeBases.length
    // 正向恢复只 upsert、不删除现有知识库（内容无价，宁多勿删）；回滚路径必须清掉
    // 失败恢复中途插入的多余库，否则旧快照无法完整还原。刚插入的库没有文档，级联删除安全。
    if (pruneMissingBases && knowledgeBases.length) {
      operations.push({
        sql: `DELETE FROM knowledge_bases WHERE id NOT IN (${knowledgeBases.map(() => "?").join(",")})`,
        params: knowledgeBases.map(row => text(row.id)),
      })
    }
    for (const row of knowledgeBases) operations.push({
      sql: `INSERT INTO knowledge_bases(id, name, description, embedding_model_name, embedding_dimensions, distance_metric, chunk_strategy_json, retrieval_json, protected, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, embedding_model_name=excluded.embedding_model_name, embedding_dimensions=excluded.embedding_dimensions, distance_metric=excluded.distance_metric, chunk_strategy_json=excluded.chunk_strategy_json, retrieval_json=excluded.retrieval_json, protected=excluded.protected, updated_at=excluded.updated_at`,
      params: [text(row.id), text(row.name), text(row.description), text(row.embedding_model_name), number(row.embedding_dimensions), text(row.distance_metric || "cosine"), text(row.chunk_strategy_json || "{}"), text(row.retrieval_json || "{}"), number(row.protected), number(row.created_at), number(row.updated_at)],
    })
  }

  const knowledgeGrants = rowsOf(tables, "knowledgeGrants")
  if (knowledgeGrants) {
    counts.knowledgeGrants = knowledgeGrants.length
    operations.push({ sql: "DELETE FROM knowledge_grants", params: [] })
    for (const row of knowledgeGrants) operations.push({
      sql: "INSERT INTO knowledge_grants(id, knowledge_base_id, subject_type, subject_id, group_id, effect, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      params: [text(row.id), text(row.knowledge_base_id), text(row.subject_type), text(row.subject_id), text(row.group_id), text(row.effect), number(row.created_at), number(row.updated_at)],
    })
  }

  if (operations.length) await sqliteClient.transaction(operations)
  await capabilityStore.load()
  return { restored: true, counts }
}

export async function createConfigBackup(): Promise<{
  file: string
  fileName: string
  sqliteAvailable: boolean
  counts: Record<string, number>
}> {
  const sqliteConfig = await snapshotSqliteConfig()
  const file = await configStore.backup("manual", { sqliteConfig })
  const counts = Object.fromEntries(Object.entries(sqliteConfig.tables || {}).map(([key, rows]) => [key, rows.length]))
  return { file, fileName: path.basename(file), sqliteAvailable: sqliteConfig.available, counts }
}

export async function restoreConfigBackup(fileName: unknown) {
  const rollbackState: { snapshot: SqliteConfigSnapshot | null } = { snapshot: null }
  try {
    const saved = await configStore.restoreBackup(String(fileName || ""), {
      beforeSave: async (sqliteConfig: unknown) => {
        const candidate = record(sqliteConfig) as unknown as SqliteConfigSnapshot
        if (!candidate.available) return
        rollbackState.snapshot = await snapshotSqliteConfig()
        await restoreSqliteConfig(candidate)
      },
    })
    return saved
  } catch (error) {
    const previous: SqliteConfigSnapshot | null = rollbackState.snapshot
    if (previous && previous.available) {
      try {
        await restoreSqliteConfig(previous, { pruneMissingBases: true })
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "配置恢复失败，且 SQLite 配置回滚未完成")
      }
    }
    throw error
  }
}
