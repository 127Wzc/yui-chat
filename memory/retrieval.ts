import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { memoryRepository } from "./repository.js"
import { scopesFor } from "./scopes.js"
import type { MemoryScope } from "./scopes.js"
import { statusFor } from "./decay.js"
import { vectorRecall } from "./vector-recall.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function score(item: UnknownRecord, index = 0): number {
  const status = statusFor(item)
  const statusScore = ({ active: 3, warm: 2, cold: 1 } as Record<string, number>)[status] || 0
  const scopeScore = ({ user: 4, user_group: 3, group: 2 } as Record<string, number>)[String(item.scope_type)] || 0
  return Number(item.score || 0) + Number(item.importance || 0) * 3 + Number(item.confidence || 0) * 2 + statusScore + scopeScore - index * 0.001
}

function boundedRetrievalLimit(value: unknown, fallback = 3): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(20, Math.max(1, Math.trunc(parsed)))
}

// 显式传入 limit（例如 memory_search 工具）时尊重调用方；普通对话不传 limit，
// 这时按全局默认并应用当前群的单群覆盖值。
export async function resolveMemoryRetrievalLimit(e: UnknownRecord = {}, explicitLimit?: unknown): Promise<number> {
  if (explicitLimit !== undefined && explicitLimit !== null) return boundedRetrievalLimit(explicitLimit)
  const root = record(configStore.get())
  const memory = record(root.memory)
  const retrieval = record(memory.retrieval)
  const globalLimit = boundedRetrievalLimit(retrieval.resultLimit, 3)
  if (e.isGroup !== true || !sqliteClient.status.available) return globalLimit
  const groupId = String(e.group_id || "").trim()
  if (!groupId) return globalLimit
  try {
    const row = await sqliteClient.get("SELECT retrieval_result_limit FROM group_memory_policies WHERE group_id=?", [groupId])
    return row?.retrieval_result_limit === null || row?.retrieval_result_limit === undefined
      ? globalLimit
      : boundedRetrievalLimit(row.retrieval_result_limit, globalLimit)
  } catch {
    // 单群策略读取失败时保持全局默认，不影响正常对话。
    return globalLimit
  }
}

export async function retrieveMemory(e: UnknownRecord = {}, query: unknown, options: UnknownRecord = {}): Promise<UnknownRecord[]> {
  const scopes: MemoryScope[] = scopesFor(e)
  const limit = await resolveMemoryRetrievalLimit(e, options.limit)
  const rows = query
    ? await memoryRepository.search(scopes, query, { limit: options.candidateLimit || 20 })
    : await memoryRepository.list(scopes, { limit, includeCold: false })
  let candidates = rows
  if (query && vectorRecall.enabled()) {
    // adaptiveVector=true 时只在 FTS 命中不足目标条数才补语义候选（节约 API）；false 则每次都补。
    const root = record(configStore.get())
    const memory = record(root.memory)
    const retrieval = record(memory.retrieval)
    const adaptive = retrieval.adaptiveVector !== false
    if ((!adaptive || rows.length < limit) && await vectorRecall.hasAnyMemory(scopes)) {
      const vectorRows = await vectorRecall.queryMemoryVectors(scopes, query, { event: e })
      // 按 id 去重合并：同一条记忆保留 FTS 行（bm25 分数），向量行只补 FTS 没召回的部分；
      // 向量层失败会返回空数组，不影响 FTS 结果。
      const seen = new Set(rows.map(row => String(row.id || "")))
      candidates = [...rows, ...vectorRows.filter(row => !seen.has(String(row.id || "")))]
    }
  }
  return candidates
    .map((item, index) => ({ ...item, computedStatus: statusFor(item), _score: score(item, index) }))
    .filter(item => ["active", "warm", "cold"].includes(item.computedStatus) && !(item.type === "episode" && item.source === "interaction"))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...item }) => item)
}
