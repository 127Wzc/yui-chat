import { resolveKnowledgeResultLimit, searchKnowledgeDetailed as searchDocuments, type KnowledgeResult, type KnowledgeSearchOptions, type RetrievalDiagnostics } from "./document-retrieval.js"

export { buildKnowledgePrompt, knowledgeQueryTerms } from "./document-retrieval.js"
export type { KnowledgeResult, KnowledgeSearchOptions, KnowledgePromptResult, RetrievalDiagnostics } from "./document-retrieval.js"

type Row = Record<string, any>

/** 公共知识查询：授权范围内并发召回，统一融合、可选重排及指令冲突处理。 */
export async function searchKnowledgeDetailed(event: Row, query: unknown, options: KnowledgeSearchOptions = {}): Promise<{ results: KnowledgeResult[]; retrieval: RetrievalDiagnostics }> {
  return searchDocuments(event, query, { ...options, limit: resolveKnowledgeResultLimit(options.limit) })
}

export async function searchKnowledge(event: Row, query: unknown, options: KnowledgeSearchOptions = {}): Promise<KnowledgeResult[]> {
  return (await searchKnowledgeDetailed(event, query, options)).results
}
