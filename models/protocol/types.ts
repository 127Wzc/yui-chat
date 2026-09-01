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

/** 模型请求消息；content 允许内部消息链，协议适配器再决定具体格式。 */
export interface ModelMessage {
  role: ModelRole
  content: string | ContentPart[] | null
  name?: string
  toolCallId?: string
  toolCalls?: ModelToolCall[]
  metadata?: Record<string, JsonValue>
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

/** 供应商无关的模型请求。 */
export interface ModelRequest {
  channel: ModelChannel
  messages: ModelMessage[]
  tools?: ToolDefinition[]
  toolChoice?: ModelToolChoice
  maxTokens?: number
  signal?: AbortSignal
  metadata?: Record<string, JsonValue>
}

/** embedding 请求。 */
export interface EmbeddingRequest {
  channel: ModelChannel
  texts: string[]
  dimensions?: number
  signal?: AbortSignal
}

/** embedding 响应。 */
export interface EmbeddingResponse {
  vectors: number[][]
  dimensions: number
  model: string
  usage: ModelUsage
}

export type ModelToolResult = ToolOutput | string | JsonValue
