// 既有知识库调用方继续使用本入口；新调用方引用共用的模型重排能力。
export { rerankCandidates as rerankKnowledge } from "../models/retrieval-rerank.js"
export type { RetrievalRerankTrace as KnowledgeRerankTrace } from "../models/retrieval-rerank.js"
