import { configStore } from "../config/store.js"
import { knowledgeRepository } from "./repository.js"
import { searchKnowledge, type KnowledgeResult } from "./retrieval.js"
import { buildCommandRecommendationResult } from "./command-query-service.js"

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
  const limit = Math.max(1, Math.min(20, numberValue(opts.limit, 5) || 5))
  const lexical = observer.recommendCommands(query, { ...opts, limit: Math.max(limit, numberValue(opts.lexicalLimit, 20) || 20) })
  const config = record(configStore.get())
  const knowledge = record(config.knowledge)
  const strategy = record(knowledge.commandRetrieval)
  const base = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
  const mode = text(strategy.mode || "hybrid").toLowerCase()
  const baseConfig = record(base?.config)
  const modelName = text(baseConfig.embeddingModel)
  const dimensions = numberValue(baseConfig.dimensions, 0)
  if (mode === "lexical" || !modelName || !dimensions) {
    return { ...lexical, retrieval: { mode: "lexical", model: "", vectorAvailable: false } }
  }

  let vectorResults: KnowledgeResult[] = []
  try {
    vectorResults = await searchKnowledge(
      { isMaster: true, isGroup: false, user_id: "command-retrieval" },
      query,
      {
        knowledgeBaseIds: [BUILTIN_COMMANDS_ID],
        useVector: true,
        vectorOnly: true,
        vectorCandidateLimit: numberValue(strategy.vectorCandidateLimit || record(knowledge.retrieval).vectorCandidateLimit, 30) || 30,
        limit: Math.max(limit, numberValue(strategy.vectorCandidateLimit, 12) || 12),
      },
    )
  } catch {
    return { ...lexical, retrieval: { mode: "lexical", model: modelName, vectorAvailable: false, fallback: true } }
  }

  const commands = new Map(observer.searchableCommands().map(item => [text(item.id), item]))
  const fused = new Map<string, FusedEntry>()
  const lexicalWeight = numberValue(strategy.lexicalWeight, 1) || 1
  const vectorWeight = numberValue(strategy.vectorWeight, 0.65) || 0.65
  const lexicalResults = Array.isArray(lexical.results) ? lexical.results.filter(item => item && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
  for (const [rank, item] of lexicalResults.entries()) {
    const itemId = text(item.id)
    if (!itemId) continue
    const current = fused.get(itemId) || { item, score: 0, methods: new Set<string>() }
    current.score += lexicalWeight / (60 + rank + 1)
    current.methods.add("keyword")
    current.item = { ...current.item, retrievalMethod: "keyword" }
    fused.set(itemId, current)
  }
  for (const [rank, item] of vectorResults.entries()) {
    const commandId = text(item.commandId || item.metadata.commandId)
    const command = commands.get(commandId)
    if (!command) continue
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
      reason: text(current.item.reason) || "语义匹配指令说明与示例",
    }
    fused.set(commandId, current)
  }
  const results = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item)
  return {
    query: lexical.query,
    generatedAt: new Date().toISOString(),
    count: results.length,
    results,
    summary: results.length
      ? results.map((item, index) => `${index + 1}. ${text(record(item.recommendation).command || item.suggestedCommand || item.fnc)}：${text(record(item.recommendation).reason || item.reason || "匹配指令知识库")}`).join("\n")
      : "没有找到匹配的指令。",
    retrieval: { mode: "hybrid", model: modelName, vectorAvailable: true, vectorResults: vectorResults.length },
  }
}
