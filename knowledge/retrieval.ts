import { configStore } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { commandPrefixes } from "../core/message/command-prefixes.js"
import { assertKnowledgeAccess, authorizedKnowledgeBaseIds } from "./access.js"
import { commandImports } from "./command-import.js"
import { commandPriorityMetadata, orderEquivalentCommandMatches } from "./command-document-builder.js"
import { buildCommandRecommendations } from "./command-query-service.js"
import { recommendCommandHybrid } from "./command-hybrid-retrieval.js"
import { knowledgeRepository } from "./repository.js"
import { resolveKnowledgeResultLimit, searchKnowledgeDetailed as searchDocuments, type KnowledgeResult, type KnowledgeSearchOptions, type RetrievalDiagnostics } from "./document-retrieval.js"

export { buildKnowledgePrompt, knowledgeQueryTerms } from "./document-retrieval.js"
export type { KnowledgeResult, KnowledgeSearchOptions, KnowledgePromptResult, RetrievalDiagnostics } from "./document-retrieval.js"

type Row = Record<string, any>
const BUILTIN_COMMANDS_ID = "builtin-commands"

/** 公共知识查询入口：内置指令库始终遵循全局指令推荐策略，普通知识保持文档检索。 */
export async function searchKnowledgeDetailed(event: Row, query: unknown, options: KnowledgeSearchOptions = {}): Promise<{ results: KnowledgeResult[]; retrieval: RetrievalDiagnostics }> {
  const limit = resolveKnowledgeResultLimit(options.limit)
  options = { ...options, limit }
  if (!sqliteClient.status.available || !String(query ?? "").trim()) return searchDocuments(event, query, options)
  const explicit = options.knowledgeBaseIds?.map(String).filter(Boolean) || []
  const allowed = explicit.length ? await assertKnowledgeAccess(event, explicit) : await authorizedKnowledgeBaseIds(event)
  if (!allowed.includes(BUILTIN_COMMANDS_ID)) return searchDocuments(event, query, { ...options, knowledgeBaseIds: allowed })

  const config = configStore.get() as Row
  const commands = (await commandImports.list()).filter(row => row.enabled).map(row => ({ ...row.metadata, sourceId: row.sourceId, id: row.id, retrievalText: row.retrievalText, suggestedCommand: row.metadata.suggestedCommand || row.title, description: row.metadata.description || row.title }))
  const recommendation = await recommendCommandHybrid({
    searchableCommands: () => commands,
    recommendCommands: (value, opts) => buildCommandRecommendations(commands, value, {
      ...opts, commandPrefixes: commandPrefixes(config), minRelevance: config.knowledge.retrieval.minRelevance,
    }),
  }, query, { limit, event })
  const base = await knowledgeRepository.getBase(BUILTIN_COMMANDS_ID)
  const recommended = recommendation.results as Row[]
  const sourceKeys = recommended.map(command => `command:${command.id}`)
  const documents = sourceKeys.length ? await sqliteClient.all<Row>(`SELECT id, source_key, content FROM knowledge_documents WHERE knowledge_base_id=? AND source_type='command' AND source_key IN (${sourceKeys.map(() => "?").join(",")})`, [BUILTIN_COMMANDS_ID, ...sourceKeys]) : []
  const bySource = new Map(documents.map(row => [String(row.source_key), row]))
  const commandResults: KnowledgeResult[] = recommended.map(command => ({
    id: String(command.id), commandId: String(command.id), knowledgeBaseId: BUILTIN_COMMANDS_ID,
    knowledgeBaseName: String(base?.name || "内置指令知识库"), documentId: String(bySource.get(`command:${command.id}`)?.id || ""),
    fieldDescription: String(base?.config?.fieldDescription || ""),
    title: String(command.suggestedCommand || command.example || command.fnc),
    content: String(bySource.get(`command:${command.id}`)?.content || [command.description || command.summary, command.body, ...(command.examples || []), ...(command.parameterHints || []).map((hint: Row) => `${hint.name} ${hint.description || ""}`)].filter(Boolean).join("\n")),
    source: String(command.pluginName || command.pluginKey || "指令"),
    score: Number(command.fusionScore) || 0,
    retrievalMethod: String(command.retrievalMethod || "keyword"),
    rerankScore: command.rerankScore,
    vectorSimilarity: command.vectorSimilarity, distance: command.distance, distanceMetric: command.distanceMetric,
    metadata: { commandId: command.id, origin: command.origin, command: { ...command, ...commandPriorityMetadata(command) } },
  }))
  const state = recommendation.retrieval as Row
  const retrieval: RetrievalDiagnostics = { mode: state.mode, configuredMode: state.configuredMode, vectorAvailable: Boolean(state.vectorAvailable), fallbackReasons: state.fallbackReasons || [], filtered: Number(state.filtered) || 0, candidates: Number(state.candidates) || 0, rerank: state.rerank, bases: state.bases || [], threshold: Number(config.knowledge.retrieval.minRelevance), commandOrdering: "relevance-with-command-priority" }
  retrieval.relevancePolicy = state.relevancePolicy
  retrieval.relevanceFiltered = state.relevanceFiltered
  const ordinary = allowed.filter(id => id !== BUILTIN_COMMANDS_ID)
  if (!ordinary.length) return { results: commandResults.slice(0, limit), retrieval }

  const other = await searchDocuments(event, query, { ...options, knowledgeBaseIds: ordinary })
  const results = [...commandResults, ...other.results].sort((a, b) => b.score - a.score)
  const ordered = orderEquivalentCommandMatches(results.filter(item => item.knowledgeBaseId === BUILTIN_COMMANDS_ID), item => item.metadata.command)
  let index = 0
  retrieval.mode = retrieval.vectorAvailable || other.retrieval.vectorAvailable ? "hybrid" : "lexical"
  retrieval.vectorAvailable ||= other.retrieval.vectorAvailable
  retrieval.fallbackReasons = [...new Set([...retrieval.fallbackReasons, ...other.retrieval.fallbackReasons])]
  retrieval.filtered += other.retrieval.filtered
  retrieval.candidates += other.retrieval.candidates
  retrieval.bases.push(...other.retrieval.bases)
  return { results: results.map(row => row.knowledgeBaseId === BUILTIN_COMMANDS_ID ? ordered[index++] : row).slice(0, limit), retrieval }
}

export async function searchKnowledge(event: Row, query: unknown, options: KnowledgeSearchOptions = {}): Promise<KnowledgeResult[]> {
  return (await searchKnowledgeDetailed(event, query, options)).results
}
