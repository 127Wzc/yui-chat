import { commandAvailability, readCommandAvailability } from "./command-availability.js"
import { configStore } from "../config/store.js"
import { knowledgeRepository } from "./repository.js"
import { resolveKnowledgeResultLimit, searchKnowledgeDetailed, type KnowledgeResult } from "./document-retrieval.js"
import { assertKnowledgeAccess } from "./access.js"
import { rerankKnowledge } from "./retrieval-rerank.js"
import { buildCommandRecommendationResult, selectRelevantCommandCandidates } from "./command-query-service.js"
import { orderEquivalentCommandMatches, collapseEquivalentCommandMatches } from "./command-document-builder.js"

type UnknownRecord = Record<string, unknown>

interface HybridOptions extends UnknownRecord {
  limit?: unknown
  lexicalLimit?: unknown
  signal?: AbortSignal
}

interface CommandObserverLike {
  recommendCommands(query: unknown, options?: UnknownRecord): UnknownRecord
  searchableCommands(): UnknownRecord[]
}

interface FusedEntry {
  item: UnknownRecord
  score: number
  methods: Set<string>
}

const BUILTIN_COMMANDS_ID = "builtin-commands"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

/**
 * 指令混合召回：并发全文与向量任务，精确匹配补充词法路，再经 RRF、可选重排和冲突排序。
 * 向量不可用或配置不完整时返回纯关键词结果，不把 embedding 故障传播到聊天入口。
 */
export async function recommendCommandHybrid(observer: CommandObserverLike, query: unknown, opts: HybridOptions = {}): Promise<UnknownRecord> {
  const event = record(opts.event)
  if (opts.event) await assertKnowledgeAccess(event, [BUILTIN_COMMANDS_ID])
  const limit = resolveKnowledgeResultLimit(opts.limit)
  const config = record(configStore.get())
  const knowledge = record(config.knowledge)
  const strategy = record(knowledge.commandRetrieval)
  const base = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
  const mode = text(strategy.mode || "hybrid").toLowerCase()
  const baseConfig = record(base?.config)
  const modelName = text(baseConfig.embeddingModel)
  const dimensions = numberValue(baseConfig.dimensions, 0)
  const commands = new Map(observer.searchableCommands().map(item => [text(item.id), item]))
  const candidateLimit = Math.max(limit, Math.min(100, numberValue(opts.lexicalLimit, 30)))
  const searchEvent = opts.event ? event : { isMaster: true, isGroup: false, user_id: "command-retrieval" }
  // 向量任务先启动；等待 embedding 的同时执行全文与本地精确匹配。
  const vectorPromise = mode !== "lexical" && modelName && dimensions && commands.size
    ? searchKnowledgeDetailed(searchEvent, query, { knowledgeBaseIds: [BUILTIN_COMMANDS_ID], useVector: true, vectorOnly: true, rerank: false, prioritizeCommands: false, signal: opts.signal, sendableCommandsOnly: true,
      vectorCandidateLimit: numberValue(strategy.vectorCandidateLimit || record(knowledge.retrieval).vectorCandidateLimit, 30), limit: 30 })
    : Promise.resolve(null)
  const lexicalPromise = (async () => {
    const local = observer.recommendCommands(query, { ...opts, prioritizeCommands: false, limit: candidateLimit })
    const localRows = Array.isArray(local.results) ? local.results as UnknownRecord[] : []
    let indexed: UnknownRecord[] = []
    let fallback = ""
    try {
      const searched = await searchKnowledgeDetailed(searchEvent, query, { knowledgeBaseIds: [BUILTIN_COMMANDS_ID], useVector: false, rerank: false, prioritizeCommands: false, candidateLimit, limit: 30, sendableCommandsOnly: true, signal: opts.signal })
      indexed = searched.results.flatMap(item => {
        const command = commands.get(text(item.commandId || item.metadata.commandId))
        return command ? [{ ...buildCommandRecommendationResult(command, query, { score: item.lexicalRelevance || 0, reason: "全文匹配指令说明与示例" }), lexicalRelevance: item.lexicalRelevance }] : []
      })
      fallback = searched.retrieval.fallbackReasons?.join(";") || ""
    } catch { fallback = "fts_search_failed" }
    const combined = [...localRows.filter(item => item.exactCommandMatch), ...indexed, ...localRows]
    const results = [...new Map(combined.map(item => [text(item.id), item])).values()].slice(0, candidateLimit)
    return { ...local, results, fallback }
  })()
  const [lexicalSettled, vectorSettled] = await Promise.allSettled([lexicalPromise, vectorPromise])
  opts.signal?.throwIfAborted()
  const lexical = lexicalSettled.status === "fulfilled" ? lexicalSettled.value : { query, results: [], fallback: "keyword_search_failed" }

  const finish = async (candidates: UnknownRecord[], retrieval: UnknownRecord): Promise<UnknownRecord> => {
    const state = await readCommandAvailability()
    const results = collapseEquivalentCommandMatches(orderEquivalentCommandMatches(candidates.filter(item => commandAvailability(text(item.id), text(item.sourceId || "yunzai"), item, state).enabled))).slice(0, limit)
    return { query: text(query), generatedAt: new Date().toISOString(), count: results.length, results,
      knowledgeBase: { id: BUILTIN_COMMANDS_ID, name: base?.name || "内置指令知识库", fieldDescription: baseConfig.fieldDescription || "" },
      summary: results.length ? results.map((item, index) => `${index + 1}. ${text(record(item.recommendation).command || item.suggestedCommand || item.fnc)}：${text(record(item.recommendation).reason || item.reason || "匹配指令知识库")}`).join("\n") : "没有找到匹配的指令。",
      retrieval: { candidates: candidates.length, ...retrieval, configuredMode: mode, commandOrdering: "relevance-with-command-priority" },
    }
  }
  const rerankRelevant = async (candidates: UnknownRecord[]): Promise<{ results: UnknownRecord[]; state: string; policy: string; filtered: number }> => {
    const selected = selectRelevantCommandCandidates(candidates)
    const reranked = await rerankKnowledge(event, text(query), selected.results.map(item => ({ ...item, id: text(item.id), title: text(item.suggestedCommand), content: text(item.retrievalText || item.description) + (item.retrievalText ? "" : "\n" + text(item.body)), score: numberValue(item.fusionScore), knowledgeBaseId: BUILTIN_COMMANDS_ID, fieldDescription: text(baseConfig.fieldDescription) })), record(knowledge.retrieval), opts.signal)
    const validated = ["applied", "cached"].includes(reranked.state)
    return { results: reranked.results, state: reranked.state, policy: selected.policy === "hybrid-candidates" && validated ? "rerank-validated" : selected.policy, filtered: candidates.length - reranked.results.length }
  }
  const localResult = async (reason?: string): Promise<UnknownRecord> => {
    const candidates: UnknownRecord[] = ((Array.isArray(lexical.results) ? lexical.results : []) as UnknownRecord[]).map((item, index) => ({ ...item, retrievalMethod: "keyword", fusionScore: 1 / (60 + index + 1) }))
    const reranked = await rerankRelevant(candidates)
    return finish(reranked.results, { mode: "lexical", model: modelName, vectorAvailable: false, fallbackReasons: [reason, lexical.fallback].filter(Boolean), rerank: reranked.state, relevancePolicy: reranked.policy, relevanceFiltered: reranked.filtered, filtered: reranked.filtered })
  }
  if (mode === "lexical" || !modelName || !dimensions || !commands.size) return localResult(mode === "lexical" ? undefined : "embedding_not_configured")

  if (vectorSettled.status === "rejected") return localResult("vector_search_failed")
  const searched = vectorSettled.value
  const vectorResults: KnowledgeResult[] = searched?.results || []
  const vectorState: UnknownRecord = (searched ? { ...searched.retrieval } : null) || { vectorAvailable: false, fallbackReasons: [] }
  if (lexical.fallback) vectorState.fallbackReasons = [...(Array.isArray(vectorState.fallbackReasons) ? vectorState.fallbackReasons : []), lexical.fallback]
  const fused = new Map<string, FusedEntry>()
  const lexicalWeight = numberValue(strategy.lexicalWeight, 1)
  const vectorWeight = numberValue(strategy.vectorWeight, 0.65)
  const lexicalResults = Array.isArray(lexical.results) ? lexical.results.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
  for (const [rank, item] of lexicalResults.entries()) {
    if (lexicalWeight <= 0) break
    const itemId = text(item.id)
    if (!itemId) continue
    const current = fused.get(itemId) || { item, score: 0, methods: new Set<string>() }
    current.score += lexicalWeight / (60 + rank + 1)
    current.methods.add("keyword")
    current.item = { ...current.item, retrievalMethod: "keyword" }
    fused.set(itemId, current)
  }
  const seenCommands = new Set<string>()
  for (const [rank, item] of vectorResults.entries()) {
    if (vectorWeight <= 0) break
    const commandId = text(item.commandId || item.metadata.commandId)
    const command = commands.get(commandId)
    if (!command || seenCommands.has(commandId)) continue
    seenCommands.add(commandId)
    const current = fused.get(commandId) || {
      item: buildCommandRecommendationResult(command, query, {
        score: Math.max(1, numberValue(item.score, 0) * 10),
        reason: "语义匹配指令说明与示例",
      }),
      score: 0,
      methods: new Set<string>(),
    }
    current.score += vectorWeight / (60 + rank + 1)
    current.methods.add("vector")
    current.item = {
      ...current.item,
      retrievalMethod: [...current.methods].join("+") || "vector",
      retrievalScore: numberValue(item.score, 0),
      vectorSimilarity: item.vectorSimilarity,
      distance: item.distance,
      distanceMetric: item.distanceMetric,
      reason: text(current.item.reason) || "语义匹配指令说明与示例",
    }
    fused.set(commandId, current)
  }
  const candidates: UnknownRecord[] = [...fused.values()]
    .sort((a, b) => Number(Boolean(b.item.exactCommandMatch)) - Number(Boolean(a.item.exactCommandMatch)) || b.score - a.score)
    .map(({ item, score }) => ({ ...item, fusionScore: score }))
  const reranked = await rerankRelevant(candidates)
  return finish(reranked.results, { ...vectorState, mode: vectorState.vectorAvailable ? "hybrid" : "lexical", model: modelName, vectorAvailable: Boolean(vectorState.vectorAvailable), vectorResults: vectorResults.length, rerank: reranked.state, relevancePolicy: reranked.policy, relevanceFiltered: reranked.filtered, filtered: numberValue(vectorState.filtered) + reranked.filtered })
}
