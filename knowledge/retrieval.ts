import { sqliteClient } from "../core/storage/sqlite/client.js"
import { assertKnowledgeAccess, authorizedKnowledgeBaseIds } from "./access.js"
import { estimateTokens, truncateTextToTokens } from "../core/chat/token-budget.js"
import { embeddingRunner } from "../models/embeddings/runner.js"
import { knowledgeRepository } from "./repository.js"
import { vectorIndex, vectorSpaceMatches } from "./vector-index.js"

type UnknownRecord = Record<string, unknown>

interface KnowledgeEvent extends UnknownRecord {
  isGroup?: boolean
  user_id?: unknown
  group_id?: unknown
}

interface KnowledgeSearchRow extends UnknownRecord {
  chunk_id?: unknown
  knowledge_base_id?: unknown
  knowledge_base_name?: unknown
  document_id?: unknown
  title?: unknown
  content?: unknown
  metadata_json?: unknown
  source_name?: unknown
  score?: unknown
}

export interface KnowledgeResult {
  id: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  documentId: string
  title: string
  content: string
  score: number
  source: string
  metadata: UnknownRecord
  commandId: string
}

export interface KnowledgeSearchOptions {
  knowledgeBaseIds?: unknown[]
  candidateLimit?: unknown
  vectorOnly?: boolean
  useVector?: boolean
  vectorCandidateLimit?: unknown
  vectorWeight?: unknown
  limit?: unknown
}

export interface KnowledgePromptResult {
  knowledgeBaseName?: unknown
  title?: unknown
  content?: unknown
}

interface QueryEmbedding {
  vectors: number[][]
  dimensions: number
  model: string
}

interface QueryCacheEntry {
  value: QueryEmbedding
  expiresAt: number
}

const queryCache = new Map<string, QueryCacheEntry>()
const QUERY_CACHE_LIMIT = 128
const QUERY_CACHE_TTL_MS = 86400000

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function parseMetadata(value: unknown): UnknownRecord {
  if (!value) return {}
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : {}
  } catch {
    // 知识库元数据损坏时只丢弃元数据，不影响正文检索结果。
    return {}
  }
}

function ftsQuery(value: unknown = ""): string {
  const terms = text(value).match(/[\p{L}\p{N}_-]{1,32}/gu) || []
  return terms.map(term => `"${term.replaceAll('"', "")}"`).join(" OR ")
}

function toResult(row: KnowledgeSearchRow): KnowledgeResult {
  const metadata = parseMetadata(row.metadata_json)
  return {
    id: text(row.chunk_id),
    knowledgeBaseId: text(row.knowledge_base_id),
    knowledgeBaseName: text(row.knowledge_base_name),
    documentId: text(row.document_id),
    title: text(row.title),
    content: text(row.content),
    score: numberValue(row.score, 0),
    source: text(row.source_name || row.title),
    metadata,
    commandId: text(metadata.commandId),
  }
}

export async function searchKnowledge(e: KnowledgeEvent, query: unknown, options: KnowledgeSearchOptions = {}): Promise<KnowledgeResult[]> {
  const queryText = text(query).trim()
  if (!sqliteClient.status.available || !queryText) return []
  const explicitIds = Array.isArray(options.knowledgeBaseIds) ? options.knowledgeBaseIds.map(text).filter(Boolean) : []
  const allowed = explicitIds.length ? await assertKnowledgeAccess(e, explicitIds) : await authorizedKnowledgeBaseIds(e)
  if (!allowed.length) return []
  const q = ftsQuery(queryText)
  if (!q) return []
  const limit = Math.max(1, Math.min(30, numberValue(options.candidateLimit, 30) || 30))
  const placeholders = allowed.map(() => "?").join(",")
  const sql = `SELECT c.id AS chunk_id, c.document_id, c.content, d.title, d.metadata_json, d.title AS source_name,
                      b.id AS knowledge_base_id, b.name AS knowledge_base_name, -bm25(knowledge_fts) AS score
               FROM knowledge_fts
               JOIN knowledge_chunks c ON c.id = knowledge_fts.chunk_id
               JOIN knowledge_documents d ON d.id = c.document_id
               JOIN knowledge_bases b ON b.id = c.knowledge_base_id
               WHERE knowledge_fts MATCH ? AND b.id IN (${placeholders})
               ORDER BY bm25(knowledge_fts) LIMIT ?`
  let rows: KnowledgeSearchRow[] = []
  if (options.vectorOnly !== true) {
    try {
      rows = await sqliteClient.all<KnowledgeSearchRow>(sql, [q, ...allowed, limit])
    } catch {
      // FTS 查询解析异常时仍保留本地、无模型的 LIKE 降级。
    }
  }
  if (!rows.length && options.vectorOnly !== true) {
    const like = `%${String(query).trim().slice(0, 200)}%`
    rows = await sqliteClient.all<KnowledgeSearchRow>(
      `SELECT c.id AS chunk_id, c.document_id, c.content, d.title, d.metadata_json, d.title AS source_name, b.id AS knowledge_base_id, b.name AS knowledge_base_name, 0.1 AS score
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id JOIN knowledge_bases b ON b.id=c.knowledge_base_id
       WHERE b.id IN (${placeholders}) AND (c.content LIKE ? OR d.title LIKE ?) LIMIT ?`,
      [...allowed, like, like, limit],
    )
  }
  const ftsResults = rows.map(toResult)
  const vectorResults: KnowledgeResult[] = []
  if (options.useVector === true && sqliteClient.status.vector?.available) {
    for (const baseId of allowed) {
      const base = await knowledgeRepository.getBase(baseId)
      const modelName = text(base?.config?.embeddingModel).trim()
      const dimensions = numberValue(base?.config?.dimensions, 0)
      const distanceMetric = text(base?.config?.distanceMetric || "cosine")
      const activeSpaceId = text(base?.active_vector_space_id)
      if (!modelName || !dimensions || !activeSpaceId) continue
      try {
        const space = await vectorIndex.getSpace(activeSpaceId)
        if (!vectorSpaceMatches(space, { modelName, dimensions, distanceMetric })) continue
        const key = `${baseId}:${activeSpaceId}:${modelName}:${dimensions}:${distanceMetric}:${String(query).trim().toLowerCase()}`
        const cached = queryCache.get(key)
        let embedded
        if (cached && cached.expiresAt > Date.now()) {
          // LRU：命中移到队尾；容量淘汰从队首开始，过期条目直接替换。
          queryCache.delete(key)
          queryCache.set(key, cached)
          embedded = cached.value
        } else {
          if (cached) queryCache.delete(key)
          embedded = await embeddingRunner.embedTexts({ modelName, texts: [queryText], dimensions, purpose: "embedding_knowledge" })
          queryCache.set(key, { value: embedded, expiresAt: Date.now() + QUERY_CACHE_TTL_MS })
          while (queryCache.size > QUERY_CACHE_LIMIT) {
            const oldest = queryCache.keys().next().value
            if (!oldest) break
            queryCache.delete(oldest)
          }
        }
        if (String(embedded.model || "") !== modelName || Number(embedded.dimensions) !== dimensions) continue
        const vector = embedded.vectors[0]
        if (!vector) continue
        const owners = await vectorIndex.search(space, vector, numberValue(options.vectorCandidateLimit, 30) || 30)
        const ids = owners.filter(item => item.ownerType === "knowledge_chunk").map(item => item.ownerId)
        if (!ids.length) continue
        const chunks = await sqliteClient.all<KnowledgeSearchRow>(`SELECT c.id AS chunk_id, c.document_id, c.content, d.title, d.metadata_json, d.title AS source_name, b.id AS knowledge_base_id, b.name AS knowledge_base_name FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id JOIN knowledge_bases b ON b.id=c.knowledge_base_id WHERE b.id=? AND c.id IN (${ids.map(() => "?").join(",")})`, [baseId, ...ids])
        const byId = new Map(chunks.map(item => [text(item.chunk_id), item]))
        for (const item of owners) {
          const row = byId.get(item.ownerId)
          if (row) vectorResults.push(toResult({ ...row, score: 1 / (1 + item.distance) }))
        }
      } catch {
        // embedding / vec 出错时始终保留 FTS 结果，不影响聊天。
      }
    }
  }
  const scores = new Map()
  for (const [rank, item] of ftsResults.entries()) scores.set(item.id, { item, score: 1 / (60 + rank + 1) })
  for (const [rank, item] of vectorResults.entries()) {
    const current = scores.get(item.id)
    scores.set(item.id, { item: current?.item || item, score: (current?.score || 0) + numberValue(options.vectorWeight, 1) / (60 + rank + 1) })
  }
  const resultLimit = Math.max(1, Math.min(12, numberValue(options.limit, 4) || 4))
  return [...scores.values()].sort((a, b) => b.score - a.score).map(item => item.item).slice(0, resultLimit)
}

export function buildKnowledgePrompt(results: readonly KnowledgePromptResult[] = [], tokenBudget = 800): string {
  const lines = []
  let used = 0
  for (const item of results) {
    const line = `[知识：${text(item.knowledgeBaseName)}/${text(item.title)}]\n${truncateTextToTokens(item.content, Math.max(60, tokenBudget - used))}`
    const tokens = estimateTokens(line)
    if (used + tokens > tokenBudget) continue
    lines.push(line)
    used += tokens
  }
  return lines.length ? `以下是已授权知识库的检索片段；仅在与当前问题相关时使用，不足以确定时请说明：\n${lines.join("\n\n")}` : ""
}
