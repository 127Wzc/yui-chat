import type { EmbeddingRequest, EmbeddingResponse, ModelListRequest, ModelRequest, ModelResponse } from "./types.js"

/**
 * 模型适配器的 TS 目标基类。
 *
 * 当前线上适配器仍由 JavaScript 入口加载；这个基类先固定供应商无关的协议，
 * 后续迁移 OpenAI、Claude、Gemini 等适配器时，只允许在协议转换层处理差异，
 * 不再让聊天流程感知各供应商的字段命名。
 */
export abstract class ModelAdapter {
  /** 适配器注册名，例如 openai-compatible、claude 或 gemini。 */
  abstract readonly id: string

  /** 日志和诊断使用的上游对话协议名。 */
  readonly protocol: string = "custom"

  /** 是否支持模型工具调用。 */
  readonly supportsTools: boolean = false

  /** 是否支持原生视觉输入。 */
  readonly supportsVision: boolean = false

  /** 是否支持流式文本输出。 */
  readonly supportsStreaming: boolean = false

  /** 是否支持 embedding。 */
  readonly supportsEmbeddings: boolean = false

  /** 是否支持 Responses 原生 tool_search/defer_loading。 */
  readonly supportsNativeToolSearch: boolean = false

  /** 将统一请求协议转换为供应商请求并返回统一模型响应。 */
  abstract sendMessage(request: ModelRequest): Promise<ModelResponse>

  /** 获取供应商可用模型；不支持时由基类给出明确错误。 */
  async listModels(_request?: ModelListRequest): Promise<unknown[]> {
    throw new Error(`${this.id} 适配器不支持模型列表查询`)
  }

  /** 执行 embedding；不支持时由基类给出明确错误。 */
  async embedTexts(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error(`${this.id} 适配器不支持 embedding`)
  }
}
