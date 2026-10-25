/** 专用模型独立于渠道的对话协议；自定义嵌入适配器继续由扩展注册表管理。 */
const builtinEmbeddingAdapters = new Set(["", "openai-compatible", "openai-responses", "qwen", "chatglm", "gemini", "embeddings"])

export function specializedModelAdapter(purpose: string, adapter: string): string {
  if (purpose === "rerank") return "rerank"
  if (purpose === "decision") return "systemone"
  if (purpose === "embedding" && builtinEmbeddingAdapters.has(adapter)) return "embeddings"
  return adapter
}

export function specializedAdapterPurpose(adapter: string): "embedding" | "rerank" | "decision" | undefined {
  if (adapter === "embeddings") return "embedding"
  if (adapter === "rerank") return "rerank"
  if (adapter === "systemone" || adapter === "typesafe") return "decision"
  return undefined
}
