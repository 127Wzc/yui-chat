import { commandAvailability, readCommandAvailability } from "./command-availability.js"
import { configStore } from "../config/store.js"
import { knowledgeRepository } from "./repository.js"
import { resolveKnowledgeResultLimit, searchKnowledgeDetailed, type KnowledgeResult } from "./document-retrieval.js"
import { assertKnowledgeAccess } from "./access.js"
import { rerankKnowledge } from "./retrieval-rerank.js"
import { buildCommandRecommendationResult, selectRelevantCommandCandidates } from "./command-query-service.js"
import { orderEquivalentCommandMatches } from "./command-document-builder.js"

type UnknownRecord = Record<string, unknown>

interface HybridOptions extends UnknownRecord {
  limit?: unknown
  lexicalLimit?: unknown
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
 * 指令混合召回适配器：先保留观察器的关键词结果，再用知识库向量结果补充语义命中。
 * 向量不可用或配置不完整时返回纯关键词结果，不把 embedding 故障传播到聊天入口。
 */
export async function recommendCommandHybrid(observer: CommandObserverLike, query: unknown, opts: HybridOptions = {}): Promise<UnknownRecord> {
  const event = record(opts.event)
  if (opts.event) await assertKnowledgeAccess(event, [BUILTIN_COMMANDS_ID])
  const limit = resolveKnowledgeResultLimit(opts.limit)
  // 融合阶段仍以相关性排名计分，宿主优先级在筛选结束后统一决定最终展示顺序。
  const lexical = observer.recommendCommands(query, { ...opts, prioritizeCommands: false, limit: Math.max(limit, numberValue(opts.lexicalLimit, 20) || 20) })
  const config = record(configStore.get())
  const knowledge = record(config.knowledge)
  const strategy = record(knowledge.commandRetrieval)
  const base = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
  const mode = text(strategy.mode || "hybrid").toLowerCase()
  const baseConfig = record(base?.config)
  const modelName = text(baseConfig.embeddingModel)
  const dimensions = numberValue(baseConfig.dimensions, 0)
  const finish = async (candidates: UnknownRecord[], retrieval: UnknownRecord): Promise<UnknownRecord> => {
    const state = await readCommandAvailability()
    const results = orderEquivalentCommandMatches(candidates.filter(item => commandAvailability(text(item.id), text(item.sourceId || "yunzai"), item, state).enabled)).slice(0, limit)
    return { query: lexical.query, generatedAt: new Date().toISOString(), count: results.length, results,
      knowledgeBase: { id: BUILTIN_COMMANDS_ID, name: base?.name || "内置指令知识库", fieldDescription: baseConfig.fieldDescription || "" },
      summary: results.length ? results.map((item, index) => `${index + 1}. ${text(record(item.recommendation).command || item.suggestedCommand || item.fnc)}：${text(record(item.recommendation).reason || item.reason || "匹配指令知识库")}`).join("\n") : "没有找到匹配的指令。",
      retrieval: { candidates: candidates.length, ...retrieval, configuredMode: mode, commandOrdering: "relevance-with-command-priority" },
    }
  }
  const rerankRelevant = async (candidates: UnknownRecord[]): Promise<{ results: UnknownRecord[]; state: string; policy: string; filtered: number }> => {
    const selected = selectRelevantCommandCandidates(candidates)
    const input = selected.policy === "semantic-nearest" ? candidates : selected.results
    const reranked = await rerankKnowledge(event, text(query), input.map(item => ({ ...item, id: text(item.id), title: text(item.suggestedCommand), content: text(item.retrievalText || item.description) + (item.retrievalText ? "" : "\n" + text(item.body)), score: numberValue(item.fusionScore), knowledgeBaseId: BUILTIN_COMMANDS_ID, fieldDescription: text(baseConfig.fieldDescription) })), record(knowledge.retrieval))
    const validated = ["applied", "cached"].includes(reranked.state)
    const results = selected.policy === "semantic-nearest" && !validated ? selected.results : reranked.results
    return { results, state: reranked.state, policy: selected.policy === "semantic-nearest" && validated ? "rerank-validated" : selected.policy, filtered: candidates.length - results.length }
  }
  const localResult = async (reason?: string): Promise<UnknownRecord> => {
    const candidates: UnknownRecord[] = ((Array.isArray(lexical.results) ? lexical.results : []) as UnknownRecord[]).map((item, index) => ({ ...item, retrievalMethod: "keyword", fusionScore: 1 / (60 + index + 1) }))
    const reranked = await rerankRelevant(candidates)
    return finish(reranked.results, { mode: "lexical", model: modelName, vectorAvailable: false, fallbackReasons: reason ? [reason] : [], rerank: reranked.state, relevancePolicy: reranked.policy, relevanceFiltered: reranked.filtered, filtered: reranked.filtered })
  }
  if (mode === "lexical" || !modelName || !dimensions) return localResult(mode === "lexical" ? undefined : "embedding_not_configured")

  let vectorResults: KnowledgeResult[] = []
  let vectorState: UnknownRecord = { vectorAvailable: false, fallbackReasons: [] }
  try {
    const searched = await searchKnowledgeDetailed(
      opts.event ? event : { isMaster: true, isGroup: false, user_id: "command-retrieval" },
      query,
      {
        knowledgeBaseIds: [BUILTIN_COMMANDS_ID],
        useVector: true,
        vectorOnly: true,
        rerank: false,
        prioritizeCommands: false,
        vectorCandidateLimit: numberValue(strategy.vectorCandidateLimit || record(knowledge.retrieval).vectorCandidateLimit, 30) || 30,
        limit: Math.max(limit, numberValue(strategy.vectorCandidateLimit, 12) || 12),
      },
    )
    vectorResults = searched.results
    vectorState = { ...searched.retrieval }
  } catch {
    return localResult("vector_search_failed")
  }

  const commands = new Map(observer.searchableCommands().map(item => [text(item.id), item]))
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
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, fusionScore: score }))
  const reranked = await rerankRelevant(candidates)
  return finish(reranked.results, { ...vectorState, mode: vectorState.vectorAvailable ? "hybrid" : "lexical", model: modelName, vectorAvailable: Boolean(vectorState.vectorAvailable), vectorResults: vectorResults.length, rerank: reranked.state, relevancePolicy: reranked.policy, relevanceFiltered: reranked.filtered, filtered: numberValue(vectorState.filtered) + reranked.filtered })
}
