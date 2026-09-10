import type { ContentPart, JsonValue } from "../../core/message-chain/types.js"
import { ModelAdapter as ProtocolModelAdapter } from "../protocol/adapter.js"
import type { EmbeddingRequest, EmbeddingResponse, ImageGenerationRequest, ImageGenerationResponse, ModelListRequest, ModelRequest, ModelRequestCapture, ModelResponse, ModelUsage } from "../protocol/types.js"

type UnknownRecord = Record<string, unknown>

/** 管理台和供应商模型列表共用的轻量摘要。 */
export interface ListedModel {
  id: string
  label: string
  description: string
  ownedBy: string
  methods: string[]
  raw: unknown
}

/** 向观测层发送已构建的请求体；观测失败不能影响真正的模型请求。 */
export function notifyModelRequest(
  callback: ((capture: ModelRequestCapture) => void) | undefined,
  protocol: string,
  body: unknown,
  phase?: string,
): void {
  if (!callback) return
  try {
    callback({ protocol, body, ...(phase ? { phase } : {}) })
  } catch {
    // 日志捕获属于旁路能力，不能阻断模型请求。
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? "") || ""
  } catch {
    return ""
  }
}

function displayMediaUrl(value: unknown): string {
  const url = String(value ?? "")
  if (/^data:/i.test(url)) return `${url.match(/^data:([^;,]+)/i)?.[1] || "data"} data-url`
  if (/^file:/i.test(url) || /^\/[^/]/.test(url) || /^[a-z]:[\\/]/i.test(url)) return "local-file-hidden"
  return url || "unknown"
}

/**
 * 模型适配器的运行时基类。
 *
 * 这里仅固定供应商无关的生命周期和边界工具，不负责路由、日志或宿主发送；
 * 具体适配器只需要实现协议转换和网络请求，聊天流程不直接接触供应商字段。
 */
export abstract class ModelAdapter extends ProtocolModelAdapter {
  /** 是否支持模型工具调用。 */
  override readonly supportsTools: boolean = false

  /** 是否支持原生视觉输入。 */
  override readonly supportsVision: boolean = false

  /** 是否支持流式文本输出。 */
  override readonly supportsStreaming: boolean = false

  /** 是否支持 embedding。 */
  override readonly supportsEmbeddings: boolean = false

  /** 是否支持图片生成。 */
  override readonly supportsImageGeneration: boolean = false

  /** 是否支持 Responses 原生工具搜索。 */
  override readonly supportsNativeToolSearch: boolean = false

  /** 将统一请求协议转换为供应商请求并返回统一响应。 */
  abstract override sendMessage(request: ModelRequest): Promise<ModelResponse>

  /** 获取供应商模型列表；不支持时显式失败，不在这里伪造结果。 */
  override async listModels(_request?: ModelListRequest): Promise<unknown[]> {
    throw new Error(`${this.id} adapter does not support model listing`)
  }

  /** 执行 embedding；不支持时显式失败，避免把聊天模型误当向量模型。 */
  override async embedTexts(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error(`${this.id} adapter does not support embeddings`)
  }

  /** 执行图片生成；具体协议适配器按需覆盖。 */
  override async generateImages(_request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    throw new Error(`${this.id} adapter does not support image generation`)
  }
}

/** 将供应商错误响应统一转换为可读异常，同时保留 HTTP 状态。 */
export function parseResponseData(response: Response, data: unknown): UnknownRecord {
  if (!response.ok) {
    const record = isRecord(data) ? data : {}
    const error = record.error
    const errorRecord = isRecord(error) ? error : {}
    const message = errorRecord.message ?? errorRecord.status ?? error ?? `HTTP ${response.status}`
    throw new Error(String(message))
  }
  return isRecord(data) ? data : {}
}

function usageRecord(data: unknown, kind: string): { value: UnknownRecord; present: boolean } {
  if (!isRecord(data)) return { value: {}, present: false }
  const candidate = kind === "gemini" ? data.usageMetadata : data.usage
  return isRecord(candidate) ? { value: candidate, present: true } : { value: {}, present: false }
}

function numeric(value: unknown): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

/** 兼容 OpenAI、Claude 和 Gemini 的 usage 字段，并明确标记是否由上游报告。 */
export function tokenUsage(data: unknown = {}, kind = "openai"): ModelUsage {
  const { value: usage, present } = usageRecord(data, kind)
  const inputValue = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? usage.inputTokenCount
  const outputValue = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? usage.outputTokenCount
  const input = numeric(inputValue)
  const output = numeric(outputValue)
  const total = numeric(usage.total_tokens ?? usage.totalTokenCount ?? usage.totalTokens ?? input + output) || input + output
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {}
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
  const cached = numeric(promptDetails.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedContentTokenCount)
  const reasoning = numeric(completionDetails.reasoning_tokens ?? usage.thoughtsTokenCount)
  return {
    input,
    output,
    total,
    cached,
    reasoning,
    source: present ? "reported" : "unknown",
    inputKnown: inputValue !== undefined && inputValue !== null,
    outputKnown: outputValue !== undefined && outputValue !== null,
  }
}

/** 只把可序列化对象作为工具参数；非法 JSON 或标量统一降为空对象。 */
function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items = value.map(jsonValue)
    return items.every(item => item !== undefined) ? items as JsonValue[] : undefined
  }
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).map(([key, item]) => [key, jsonValue(item)] as const)
  if (entries.some(([, item]) => item === undefined)) return undefined
  return Object.fromEntries(entries) as { [key: string]: JsonValue }
}

export function safeJson(value: unknown): Record<string, JsonValue> {
  let candidate = value
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown
    } catch {
      return {}
    }
  }
  if (!isRecord(candidate)) return {}
  const entries = Object.entries(candidate).map(([key, item]) => [key, jsonValue(item)] as const)
  return Object.fromEntries(entries.filter(([, item]) => item !== undefined)) as Record<string, JsonValue>
}

/** 将 data URL 拆成媒体类型和 Base64 正文，普通 URL 不在此处读取。 */
export function parseDataUrl(url = ""): { mediaType: string; data: string } | null {
  const match = String(url).match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i)
  return match ? { mediaType: match[1], data: match[2] } : null
}

/** 保留供应商 content 数组的原始形态，由各适配器决定如何解释未知片段。 */
export function contentParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content
  return [{ type: "text", text: contentToText(content) }]
}

/** 将普通文本和视觉片段转换成适配器日志/Mock 可消费的短文本。 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(compactJson(content))
  return content.map(part => {
    if (!isRecord(part)) return compactJson(part)
    if (part.type === "text") return String(part.text || "")
    if (part.type === "image_url") {
      const image = isRecord(part.image_url) ? part.image_url : {}
      return `[图片：${displayMediaUrl(image.url)}]`
    }
    if (part.type === "image" || part.type === "audio" || part.type === "video" || part.type === "file") {
      const source = isRecord(part.source) ? part.source : {}
      const label = part.type === "image" ? "图片" : part.type === "audio" ? "语音" : part.type === "video" ? "视频" : "文件"
      return `[${label}：${displayMediaUrl(source.value)}]`
    }
    if (part.type === "resource") return `[资源：${displayMediaUrl(part.uri || isRecord(part.source) && part.source.value)}]`
    if (part.type === "mention") return `@${String(part.userId || "")}`
    if (part.type === "reply") return part.selectedText ? `引用：${String(part.selectedText)}` : `回复消息：${String(part.messageId || "")}`
    if (part.type === "forward") return `[合并转发：${Array.isArray(part.nodes) ? part.nodes.length : 0} 条]`
    if (part.type === "extension") return `[${String(part.namespace || "扩展")}:${String(part.name || "内容")}]`
    return compactJson(part)
  }).filter(Boolean).join("\n")
}

/** 将内部消息链编码为 OpenAI-compatible 的文本/视觉消息；其他媒体保留安全摘要。 */
export function contentForOpenAI(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const parts = content.flatMap(value => {
    const part = isRecord(value) ? value : {}
    if (part.type === "text") return [{ type: "text", text: String(part.text || "") }]
    if (part.type === "image_url") return [part]
    if (part.type === "image") {
      const source = isRecord(part.source) ? part.source : {}
      const inline = String(source.inlineData || "")
      const value = inline ? `data:${String(source.mimeType || part.mimeType || "image/png")};base64,${inline}` : String(source.value || "")
      return value ? [{ type: "image_url", image_url: { url: value } }] : []
    }
    const summary = contentToText([part])
    return summary ? [{ type: "text", text: summary }] : []
  })
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts
}

export function messagesForOpenAI(messages: readonly UnknownRecord[] = []): UnknownRecord[] {
  return messages.map(message => {
    const { metadata: _metadata, protocol: _protocol, ...safeMessage } = message
    return Object.hasOwn(safeMessage, "content") ? { ...safeMessage, content: contentForOpenAI(safeMessage.content) } : safeMessage
  })
}

/** 将供应商返回的模型列表收敛为管理台和路由层使用的稳定摘要。 */
export function normalizeListedModels(items: readonly unknown[] = []): ListedModel[] {
  return items.flatMap(item => {
    const record = isRecord(item) ? item : {}
    const id = String(record.id || record.name || record.model || "").replace(/^models\//, "").trim()
    if (!id) return []
    const methodsValue = record.methods || record.supportedGenerationMethods || record.supported_generation_methods
    const methods = Array.isArray(methodsValue) ? methodsValue.map(value => String(value || "")).filter(Boolean) : []
    return [{
      id,
      label: String(record.label || record.displayName || record.display_name || id).trim() || id,
      description: String(record.description || "").trim(),
      ownedBy: String(record.ownedBy || record.owned_by || "").trim(),
      methods,
      raw: record.raw ?? item,
    }]
  })
}

export type { ContentPart, JsonValue }
