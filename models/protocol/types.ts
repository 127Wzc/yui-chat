import type { ContentPart, JsonValue, ToolOutput } from "../../core/message-chain/types.js"
import type { ToolDefinition } from "../../tools/support/tool-contract.js"

/** 供应商无关的模型消息角色。 */
export type ModelRole = "system" | "user" | "assistant" | "tool"

/** 统一的工具调用描述，供应商 function/tool_calls 字段在适配器边界转换。 */
export interface ModelToolCall {
  id: string
  name: string
  arguments: Record<string, JsonValue>
}

/** 由供应商托管执行的工具事件；不会进入本地 Tool Executor。 */
export interface ModelHostedToolCall {
  type: string
  id: string
  status: string
  execution?: string
  query?: string
  queries?: string[]
  loadedTools?: string[]
  resultCount?: number
  sources?: ModelSearchSource[]
  /** 上游返回的原始 hosted output item，仅用于有界、脱敏的审计日志。 */
  raw?: unknown
}

export interface ModelSearchSource {
  title: string
  url: string
}

/** 模型请求消息；content 允许内部消息链，协议适配器再决定具体格式。 */
export interface ModelMessage {
  role: ModelRole
  content: string | ContentPart[] | null
  name?: string
  toolCallId?: string
  toolCalls?: ModelToolCall[]
  metadata?: Record<string, JsonValue>
  /** 协议适配器要求原样回放的状态；普通消息不设置。 */
  protocol?: { kind: string; outputItems?: unknown[] }
}

export interface ResponsesStateRecovery {
  reason: "previous_response_missing" | "tool_call_link_missing"
  from: "linked"
  to: "stateless_replay"
  replayedMessages: number
  droppedToolItems: number
}

/** 统一 token 用量结构。 */
export interface ModelUsage {
  input: number
  output: number
  total: number
  cached: number
  reasoning: number
  source: "reported" | "estimated" | "unknown"
  inputKnown: boolean
  outputKnown: boolean
}

/** 供应商无关的模型终止原因；聊天循环只消费这些结构化状态。 */
export type ModelStopReason = "tool_calls" | "end_turn" | "max_tokens" | "pause_turn" | "refusal" | "error" | "unknown"

/** 模型适配器返回给聊天流程的统一响应。 */
export interface ModelResponse {
  id: string
  text: string
  toolCalls: ModelToolCall[]
  stopReason: ModelStopReason
  usage: ModelUsage
  hostedToolCalls?: ModelHostedToolCall[]
  hostedSearchSources?: ModelSearchSource[]
  /** 供应商实际返回的 Response ID；不能用本地兜底 ID 续接上游状态。 */
  upstreamResponseId?: string
  upstreamStateReset?: boolean
  /** Responses 自动模式发生断链恢复时的可观测摘要。 */
  responsesStateRecovery?: ResponsesStateRecovery
  /** 当前协议下一轮所需的原始输出项，例如 Responses reasoning/function_call items。 */
  protocol?: { kind: string; outputItems: unknown[] }
  raw?: unknown
}

/** 供应商无关的工具选择约束；具体字段只在模型适配器边界映射。 */
export type ModelToolChoice = "auto" | "none" | "required" | { type: "function"; name: string }

/** 模型列表查询请求；部分供应商需要渠道中的地址、鉴权和查询参数。 */
export interface ModelListRequest {
  channel: ModelChannel
  signal?: AbortSignal
}

/** 已解析的模型渠道配置；密钥只在运行时边界存在，不进入日志类型。 */
export interface ModelChannel {
  id?: string
  type: string
  model: string
  baseURL?: string
  apiKey?: string
  stream?: boolean
  timeoutMs?: number
  modelConfig?: Record<string, JsonValue>
  [key: string]: unknown
}

/** 适配器即将发出的协议请求快照；仅用于开发者日志，不参与模型业务。 */
export interface ModelRequestCapture {
  protocol: string
  body: unknown
  /** Responses 等协议可能在一次模型调用内发出恢复请求。 */
  phase?: string
}

/** 供应商无关的模型请求。 */
export interface ModelRequest {
  channel: ModelChannel
  messages: ModelMessage[]
  /** 上游链失效时使用的完整、有界本地上下文；正常链接请求不会发送。 */
  replayMessages?: ModelMessage[]
  tools?: ToolDefinition[]
  toolChoice?: ModelToolChoice
  maxTokens?: number
  signal?: AbortSignal
  metadata?: Record<string, JsonValue>
  onRequest?: (capture: ModelRequestCapture) => void
}

/** embedding 请求。 */
export interface EmbeddingRequest {
  channel: ModelChannel
  texts: string[]
  dimensions?: number
  signal?: AbortSignal
  onRequest?: (capture: ModelRequestCapture) => void
}

/** 生图请求中的参考图；数据只在适配器边界短暂使用，不写入业务日志。 */
export interface ImageGenerationReference {
  data: string
  mimeType?: string
  name?: string
}

/** 供应商无关的图片生成请求。 */
export interface ImageGenerationRequest {
  channel: ModelChannel
  prompt: string
  references?: ImageGenerationReference[]
  count?: number
  size?: string
  quality?: string
  aspectRatio?: string
  imageSize?: string
  background?: string
  /** 请求上游以流式方式返回生成事件；结果仍会在协议层收敛为图片数组。 */
  stream?: boolean
  /** 当前图片请求的超时；超时后直接丢弃未完成结果。 */
  timeoutMs?: number
  signal?: AbortSignal
  onRequest?: (capture: ModelRequestCapture) => void
}

/** 供应商返回的单张图片；data 统一为 data URL 或原始 Base64，url 保留远程结果。 */
export interface GeneratedImage {
  data?: string
  url?: string
  mimeType?: string
  revisedPrompt?: string
}

/** 供应商无关的图片生成响应。 */
export interface ImageGenerationResponse {
  images: GeneratedImage[]
  text?: string
  usage?: ModelUsage
  raw?: unknown
}

/** embedding 响应。 */
export interface EmbeddingResponse {
  vectors: number[][]
  dimensions: number
  model: string
  usage: ModelUsage
}

export type ModelToolResult = ToolOutput | string | JsonValue
