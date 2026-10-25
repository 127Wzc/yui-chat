import { OpenAICompatibleAdapter } from "./openai/chat/adapter.js"
import { GeminiAdapter } from "./gemini.js"
import type { RerankRequest, RerankResponse, EmbeddingRequest, EmbeddingResponse, ModelListRequest, ModelRequest, ModelResponse } from "../protocol/types.js"

/** 专用嵌入协议；保持既有 Gemini 原生传输，其他渠道使用 /embeddings。 */
export class EmbeddingsAdapter extends OpenAICompatibleAdapter {
  override readonly id = "embeddings"
  override readonly protocol = "embeddings"
  override readonly supportsTools = false
  override readonly supportsVision = false
  override readonly supportsStreaming = false
  override readonly supportsRerank: boolean = false

  override async sendMessage(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("embeddings 协议仅用于生成嵌入向量")
  }

  override async rerank(_request: RerankRequest): Promise<RerankResponse> {
    throw new Error("embeddings 协议不支持重排序")
  }

  private isGemini(channel: EmbeddingRequest["channel"]): boolean {
    const embedding = channel.modelConfig?.embedding as Record<string, unknown> | undefined
    return embedding?.protocol === "gemini"
  }

  override async embedTexts(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.isGemini(request.channel) ? new GeminiAdapter().embedTexts({ ...request, onRequest: capture => request.onRequest?.({ ...capture, protocol: this.protocol }) }) : super.embedTexts(request)
  }

  override async listModels(request: ModelListRequest): Promise<unknown[]> {
    return this.isGemini(request.channel) ? new GeminiAdapter().listModels(request) : super.listModels(request)
  }
}

/** 专用重排协议，共用兼容 /rerank 的 HTTP 编解码。 */
export class RerankAdapter extends OpenAICompatibleAdapter {
  override readonly id = "rerank"
  override readonly protocol = "rerank"
  override readonly supportsTools = false
  override readonly supportsVision = false
  override readonly supportsStreaming = false
  override readonly supportsEmbeddings = false

  override async sendMessage(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("rerank 协议仅用于检索重排序")
  }

  override async embedTexts(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("rerank 协议不支持生成嵌入向量")
  }
}
