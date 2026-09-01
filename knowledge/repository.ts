import crypto from "node:crypto"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import type { SqliteOperation } from "../core/storage/types.js"
import { vectorIndex } from "./vector-index.js"

type UnknownRecord = Record<string, unknown>

interface KnowledgeBase extends UnknownRecord {
  id?: string
  name?: string
  description?: string
  type?: string
  protected?: unknown
  built_in?: unknown
  default_active?: unknown
  auto_retrieve?: unknown
  config?: UnknownRecord
  tags?: unknown[]
  active_vector_space_id?: unknown
}

interface KnowledgeChunk {
  content: string
  contentHash: string
}

interface BaseInput extends UnknownRecord {
  id?: unknown
  name?: unknown
  description?: unknown
  type?: unknown
  protected?: unknown
  defaultActive?: unknown
  autoRetrieve?: unknown
  triggerWords?: unknown
  tags?: unknown
  config?: unknown
}

interface DocumentInput extends UnknownRecord {
  knowledgeBaseId: unknown
  sourceType?: unknown
  sourceKey?: unknown
  title?: unknown
  content?: unknown
  contentHash?: unknown
  metadata?: unknown
  chunks?: unknown
}

interface GrantInput extends UnknownRecord {
  knowledgeBaseId: unknown
  principalType: unknown
  principalId: unknown
  groupId?: unknown
  access?: unknown
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
}

const now = (): number => Date.now()
const id = (): string => crypto.randomUUID()
const parse = <T = UnknownRecord>(value: unknown, fallback: T = {} as T): T => { try { return value ? JSON.parse(String(value)) as T : fallback } catch { return fallback } }
const has = (value: UnknownRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

/**
 * 知识库持久化门面。
 *
 * 负责知识库、文档、分块、授权和向量索引的事务边界；不负责消息权限判断、模型调用或
 * 文本分块算法，调用方应分别使用 access、embedding 和 chunking 模块。
 */
export class KnowledgeRepository {
  async listBases(ids: unknown[] | null = null): Promise<KnowledgeBase[]> {
    if (!sqliteClient.status.available) return []
    const normalizedIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : []
    const filter = normalizedIds.length
      ? { sql: ` WHERE b.id IN (${normalizedIds.map(() => "?").join(",")})`, params: normalizedIds }
      : { sql: "", params: [] }
    const rows = await sqliteClient.all<UnknownRecord>(
      `SELECT b.*,
              (SELECT COUNT(*) FROM knowledge_documents d WHERE d.knowledge_base_id=b.id) AS document_count,
              (SELECT COUNT(*) FROM knowledge_chunks c WHERE c.knowledge_base_id=b.id) AS chunk_count,
              (SELECT COALESCE(SUM(LENGTH(d.content)), 0) FROM knowledge_documents d WHERE d.knowledge_base_id=b.id) AS character_count,
              (SELECT j.status FROM knowledge_index_jobs j WHERE j.knowledge_base_id=b.id ORDER BY j.updated_at DESC, j.created_at DESC LIMIT 1) AS index_status,
              (SELECT j.error FROM knowledge_index_jobs j WHERE j.knowledge_base_id=b.id ORDER BY j.updated_at DESC, j.created_at DESC LIMIT 1) AS index_error,
              (SELECT j.updated_at FROM knowledge_index_jobs j WHERE j.knowledge_base_id=b.id ORDER BY j.updated_at DESC, j.created_at DESC LIMIT 1) AS index_updated_at
       FROM knowledge_bases b${filter.sql}
       ORDER BY b.protected DESC, b.updated_at DESC`,
      filter.params,
    )
    return rows.map(row => {
      const retrieval = parse<UnknownRecord>(row.retrieval_json, {})
      const chunking = parse<UnknownRecord>(row.chunk_strategy_json, {})
      return {
        ...row,
        type: String(retrieval.type || (row.id === "builtin-commands" ? "command" : "general")),
        built_in: row.id === "builtin-commands" ? 1 : 0,
        default_active: retrieval.defaultActive ? 1 : 0,
        auto_retrieve: retrieval.autoRetrieve ? 1 : 0,
        config: { embeddingModel: row.embedding_model_name, dimensions: row.embedding_dimensions, distanceMetric: row.distance_metric, chunking, triggerWords: Array.isArray(retrieval.triggerWords) ? retrieval.triggerWords : [], ...retrieval },
        tags: Array.isArray(retrieval.tags) ? retrieval.tags : [],
        stats: { documents: Number(row.document_count || 0), chunks: Number(row.chunk_count || 0), characters: Number(row.character_count || 0) },
        index: { status: row.index_status || (row.embedding_model_name ? "not_built" : "fts_ready"), error: row.index_error || "", updatedAt: Number(row.index_updated_at || 0) },
      }
    })
  }

  async getBase(baseId: unknown): Promise<KnowledgeBase | null> { return (await this.listBases([String(baseId || "")]))[0] || null }

  async upsertBase(input: BaseInput = {}): Promise<KnowledgeBase | null> {
    const timestamp = now()
    const baseId = String(input.id || id())
    const current = await this.getBase(baseId)
    const item = {
      id: baseId,
      name: String(input.name || current?.name || "未命名知识库").trim().slice(0, 120),
      description: String(input.description || current?.description || "").trim().slice(0, 2000),
      type: String(input.type || current?.type || "general"),
      protected: has(input, "protected") ? input.protected === true : current?.protected === 1,
      defaultActive: has(input, "defaultActive") ? input.defaultActive === true : current?.default_active === 1,
      autoRetrieve: has(input, "autoRetrieve") ? input.autoRetrieve === true : current?.auto_retrieve === 1,
      triggerWords: Array.isArray(input.triggerWords) ? input.triggerWords.slice(0, 32) : (Array.isArray(current?.config?.triggerWords) ? current.config.triggerWords : []),
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 32) : (Array.isArray(current?.tags) ? current.tags : []),
      config: { ...(current?.config || {}), ...record(input.config) },
    }
    const retrieval = {
      ...item.config,
      type: item.type,
      defaultActive: item.defaultActive,
      autoRetrieve: item.autoRetrieve,
      triggerWords: item.triggerWords,
      tags: item.tags,
    }
    await sqliteClient.run(
      `INSERT INTO knowledge_bases(id, name, description, embedding_model_name, embedding_dimensions, distance_metric, chunk_strategy_json, retrieval_json, protected, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         embedding_model_name=excluded.embedding_model_name, embedding_dimensions=excluded.embedding_dimensions,
         distance_metric=excluded.distance_metric, chunk_strategy_json=excluded.chunk_strategy_json,
         retrieval_json=excluded.retrieval_json, protected=excluded.protected, updated_at=excluded.updated_at`,
      [item.id, item.name, item.description, String(item.config.embeddingModel || ""), Number(item.config.dimensions || 0), String(item.config.distanceMetric || "cosine"), JSON.stringify(item.config.chunking || {}), JSON.stringify(retrieval), item.protected ? 1 : 0, timestamp, timestamp],
    )
    return this.getBase(baseId)
  }

  async listDocuments(baseId: unknown, { query = "", limit = 200 }: { query?: unknown; limit?: unknown } = {}): Promise<UnknownRecord[]> {
    const cleanQuery = String(query || "").trim().slice(0, 200)
    const params: unknown[] = [baseId]
    let querySql = ""
    if (cleanQuery) {
      querySql = " AND (d.title LIKE ? OR d.content LIKE ?)"
      params.push(`%${cleanQuery}%`, `%${cleanQuery}%`)
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 200)))
    return sqliteClient.all<UnknownRecord>(
      `SELECT d.id, d.knowledge_base_id, d.source_key AS source_id, d.source_key, d.source_type, d.title, d.content_hash,
              d.metadata_json, d.created_at, d.updated_at, d.title AS source_name,
              COUNT(c.id) AS chunk_count, LENGTH(d.content) AS character_count,
              SUBSTR(REPLACE(REPLACE(d.content, char(13), ' '), char(10), ' '), 1, 240) AS preview
       FROM knowledge_documents d
       LEFT JOIN knowledge_chunks c ON c.document_id=d.id
       WHERE d.knowledge_base_id=?${querySql}
       GROUP BY d.id
       ORDER BY d.updated_at DESC LIMIT ?`,
      params,
    ).then(rows => rows.map(row => ({ ...row, metadata: parse(row.metadata_json), chunks: Number(row.chunk_count || 0), characters: Number(row.character_count || 0) })))
  }

  async getDocument(baseId: unknown, documentId: unknown): Promise<UnknownRecord | null> {
    const row = await sqliteClient.get<UnknownRecord>(
      "SELECT d.*, d.source_key AS source_id, d.title AS source_name FROM knowledge_documents d WHERE d.knowledge_base_id=? AND d.id=?",
      [baseId, documentId],
    )
    return row ? { ...row, metadata: parse(row.metadata_json) } : null
  }

  async replaceDocument({ knowledgeBaseId, sourceType = "text", sourceKey, title, content, contentHash, metadata = {}, chunks = [] }: DocumentInput): Promise<UnknownRecord> {
    const timestamp = now()
    const normalizedSourceKey = String(sourceKey || "source").slice(0, 1000)
    const normalizedTitle = String(title || "未命名文档").slice(0, 500)
    const base = await this.getBase(knowledgeBaseId)
    if (!base) throw new Error("知识库不存在")
    const existing = await sqliteClient.get<UnknownRecord>(
      "SELECT id, title, content_hash, metadata_json FROM knowledge_documents WHERE knowledge_base_id=? AND source_key=?",
      [knowledgeBaseId, normalizedSourceKey],
    )
    const normalizedContent = String(content || "")
    const normalizedHash = String(contentHash || "")
    const metadataJson = JSON.stringify(record(metadata))
    if (existing?.content_hash === normalizedHash && existing?.title === normalizedTitle) {
      if (existing.metadata_json !== metadataJson) await sqliteClient.run("UPDATE knowledge_documents SET metadata_json=?, updated_at=? WHERE id=?", [metadataJson, timestamp, existing.id])
      return { id: existing.id, sourceId: normalizedSourceKey, changed: false, created: false, chunks: 0 }
    }
    const documentId = String(existing?.id || id())
    const normalizedChunks: KnowledgeChunk[] = records(chunks).map(chunk => ({ content: String(chunk.content || ""), contentHash: String(chunk.contentHash || "") }))
    const operations: SqliteOperation[] = [
      {
        sql: existing
          ? "UPDATE knowledge_documents SET source_type=?, title=?, content=?, content_hash=?, metadata_json=?, updated_at=? WHERE id=?"
          : "INSERT INTO knowledge_documents(id, knowledge_base_id, source_type, source_key, title, content, content_hash, metadata_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: existing
          ? [String(sourceType), normalizedTitle, normalizedContent, normalizedHash, metadataJson, timestamp, documentId]
          : [documentId, knowledgeBaseId, String(sourceType), normalizedSourceKey, normalizedTitle, normalizedContent, normalizedHash, metadataJson, timestamp, timestamp],
      },
      { sql: "DELETE FROM knowledge_chunks WHERE document_id=?", params: [documentId] },
      ...normalizedChunks.flatMap((chunk, ordinal) => {
        const chunkId = id()
        return [
          { sql: "INSERT INTO knowledge_chunks(id, knowledge_base_id, document_id, ordinal, content, content_hash) VALUES(?, ?, ?, ?, ?, ?)", params: [chunkId, knowledgeBaseId, documentId, ordinal, chunk.content, chunk.contentHash] },
          { sql: "INSERT INTO knowledge_fts(chunk_id, knowledge_base_id, title, content) VALUES(?, ?, ?, ?)", params: [chunkId, knowledgeBaseId, normalizedTitle, chunk.content] },
        ]
      }),
    ]
    await sqliteClient.transaction(operations)
    return { id: documentId, sourceId: normalizedSourceKey, changed: true, created: !existing, chunks: normalizedChunks.length }
  }

  async deleteBase(baseId: unknown): Promise<boolean> {
    const base = await this.getBase(baseId)
    if (!base) return false
    if (base.protected || base.id === "builtin-commands") throw new Error("内置受保护知识库不能删除")
    const chunks = await sqliteClient.all<UnknownRecord>("SELECT id FROM knowledge_chunks WHERE knowledge_base_id=?", [baseId])
    const previousSpace = String(base.active_vector_space_id || "")
    const result = await sqliteClient.transaction([
      { sql: "DELETE FROM knowledge_fts WHERE knowledge_base_id=?", params: [baseId] },
      { sql: "DELETE FROM knowledge_bases WHERE id=?", params: [baseId] },
    ])
    await vectorIndex.deleteOwners("knowledge_chunk", chunks.map(chunk => chunk.id))
    if (previousSpace) await vectorIndex.deleteSpace(previousSpace)
    return Boolean(record(result.at(-1)).changes)
  }

  async deleteDocument(baseId: unknown, documentId: unknown): Promise<boolean> {
    const document = await this.getDocument(baseId, documentId)
    if (!document) return false
    const chunks = await sqliteClient.all<UnknownRecord>("SELECT id FROM knowledge_chunks WHERE knowledge_base_id=? AND document_id=?", [baseId, documentId])
    await sqliteClient.run("DELETE FROM knowledge_documents WHERE knowledge_base_id=? AND id=?", [baseId, documentId])
    await vectorIndex.deleteOwners("knowledge_chunk", chunks.map(chunk => chunk.id))
    return true
  }

  async setGrant({ knowledgeBaseId, principalType, principalId, groupId = "", access = "allow" }: GrantInput): Promise<void> {
    if (!await this.getBase(knowledgeBaseId)) throw new Error("知识库不存在")
    const subjectType = String(principalType || "")
    const effect = String(access || "allow")
    if (!["role", "user", "group", "user_group"].includes(subjectType)) throw new Error("授权主体类型无效")
    if (!String(principalId || "").trim()) throw new Error("授权主体不能为空")
    if (!["allow", "deny"].includes(effect)) throw new Error("授权效果无效")
    if (subjectType === "role" && String(principalId).trim() === "master" && effect !== "allow") throw new Error("主人固定保留知识库访问权限")
    await sqliteClient.run(
      "INSERT INTO knowledge_grants(id, knowledge_base_id, subject_type, subject_id, group_id, effect, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(knowledge_base_id, subject_type, subject_id, group_id) DO UPDATE SET effect=excluded.effect, updated_at=excluded.updated_at",
      [id(), knowledgeBaseId, subjectType, String(principalId).trim(), String(groupId || "").trim(), effect, now(), now()],
    )
  }

  async listGrants(baseId: unknown): Promise<UnknownRecord[]> {
    return sqliteClient.all<UnknownRecord>("SELECT id, subject_type AS principal_type, subject_id AS principal_id, group_id, effect AS access, 1 AS default_active, created_at, updated_at FROM knowledge_grants WHERE knowledge_base_id=? ORDER BY effect DESC, subject_type, subject_id", [baseId])
  }

  async deleteGrant(baseId: unknown, grantId: unknown): Promise<boolean> {
    const grant = await sqliteClient.get<UnknownRecord>("SELECT subject_type, subject_id, effect FROM knowledge_grants WHERE knowledge_base_id=? AND id=?", [baseId, grantId])
    if (grant?.subject_type === "role" && grant.subject_id === "master" && grant.effect === "allow") throw new Error("主人固定保留知识库访问权限")
    const result = await sqliteClient.run("DELETE FROM knowledge_grants WHERE knowledge_base_id=? AND id=?", [baseId, grantId])
    return Boolean(result.changes)
  }
}

export const knowledgeRepository = new KnowledgeRepository()
