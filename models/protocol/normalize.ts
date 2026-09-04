import type { ContentPart, JsonValue } from "../../core/message-chain/types.js"
import type { ModelHostedToolCall, ModelResponse, ModelSearchSource, ModelStopReason, ModelToolCall, ModelUsage } from "./types.js"

/** 第三方模型响应在进入统一协议前都必须先按 unknown 处理。 */
type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

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

function objectArguments(value: unknown): Record<string, JsonValue> {
  let candidate = value
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) } catch { candidate = {} }
  }
  if (!isRecord(candidate)) return {}
  const entries = Object.entries(candidate).map(([key, item]) => [key, jsonValue(item)] as const)
  return Object.fromEntries(entries.filter(([, item]) => item !== undefined)) as Record<string, JsonValue>
}

/** 返回统一的空用量，避免不同供应商缺少 usage 时出现 undefined 分支。 */
export function emptyModelUsage(source: ModelUsage["source"] = "unknown"): ModelUsage {
  return { input: 0, output: 0, total: 0, cached: 0, reasoning: 0, source, inputKnown: false, outputKnown: false }
}

/** 将 OpenAI/Claude/Gemini 常见字段归一化为供应商无关的用量结构。 */
export function normalizeModelUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) return emptyModelUsage()
  const usage = isRecord(value.usage) ? value.usage : isRecord(value.usageMetadata) ? value.usageMetadata : value
  const inputValue = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount
  const outputValue = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount
  const input = number(inputValue)
  const output = number(outputValue)
  const total = number(usage.total_tokens ?? usage.totalTokenCount) || input + output
  const cachedDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : undefined
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {}
  const cached = number(cachedDetails ?? inputDetails.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cachedContentTokenCount)
  const reasoningDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details.reasoning_tokens : undefined
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
  const reasoning = number(reasoningDetails ?? outputDetails.reasoning_tokens ?? usage.thoughtsTokenCount)
  const known = inputValue !== undefined || outputValue !== undefined
  return {
    input, output, total, cached, reasoning,
    source: known ? "reported" : "unknown",
    inputKnown: inputValue !== undefined && inputValue !== null,
    outputKnown: outputValue !== undefined && outputValue !== null,
  }
}

function normalizeToolCall(value: unknown, index: number): ModelToolCall | null {
  if (!isRecord(value)) return null
  const functionValue = isRecord(value.function) ? value.function : value
  const name = text(functionValue.name || value.name).trim()
  if (!name) return null
  return {
    id: text(value.id).trim() || `tool-call-${index + 1}`,
    name,
    arguments: objectArguments(functionValue.arguments ?? value.arguments),
  }
}

function normalizeText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(item => isRecord(item) ? text(item.text || item.content) : text(item)).join("")
  if (isRecord(value)) return text(value.text || value.content)
  return ""
}

function normalizeHostedToolCall(value: unknown): ModelHostedToolCall | null {
  if (!isRecord(value)) return null
  const type = text(value.type).trim()
  if (!type) return null
  return {
    type,
    id: text(value.id || value.call_id).trim(),
    status: text(value.status || "unknown"),
    ...(value.execution ? { execution: text(value.execution) } : {}),
    ...(value.query ? { query: text(value.query) } : {}),
    ...(Array.isArray(value.queries) ? { queries: value.queries.map(text).filter(Boolean) } : {}),
    ...(Array.isArray(value.loadedTools) ? { loadedTools: value.loadedTools.map(text).filter(Boolean) } : {}),
    ...(Number.isFinite(Number(value.resultCount)) ? { resultCount: Number(value.resultCount) } : {}),
    ...(Array.isArray(value.sources) ? { sources: value.sources.map(item => {
      const source = isRecord(item) ? item : {}
      return { title: text(source.title), url: text(source.url) }
    }).filter(item => /^https?:\/\//i.test(item.url)) } : {}),
    ...(Object.hasOwn(value, "raw") ? { raw: value.raw } : {}),
  }
}

/** 归一化 OpenAI finish_reason、Claude stop_reason 与 Gemini finishReason。 */
export function normalizeModelStopReason(value: unknown, toolCallCount = 0): ModelStopReason {
  const reason = text(value).trim().toLowerCase().replace(/[\s-]+/g, "_")
  // 截断、暂停、拒绝和错误必须优先于解析出的工具块，避免执行不完整调用。
  if (["length", "max_tokens", "max_output_tokens"].includes(reason)) return "max_tokens"
  if (["pause_turn", "paused"].includes(reason)) return "pause_turn"
  if (["refusal", "content_filter", "safety", "recitation", "blocklist", "prohibited_content", "spii"].includes(reason)) return "refusal"
  if (["error", "failed"].includes(reason)) return "error"
  if (["tool_calls", "tool_use", "function_call", "function_calls"].includes(reason)) return "tool_calls"
  if (toolCallCount > 0 && !reason) return "tool_calls"
  if (["stop", "end_turn", "completed", "complete"].includes(reason)) return toolCallCount > 0 ? "tool_calls" : "end_turn"
  return reason ? "unknown" : "end_turn"
}

/** 将不同模型适配器的原始返回归一化为统一响应，聊天流程只消费该结构。 */
export function normalizeModelResponse(value: unknown): ModelResponse {
  const response = isRecord(value) ? value : {}
  const rawCalls = Array.isArray(response.toolCalls) ? response.toolCalls : Array.isArray(response.tool_calls) ? response.tool_calls : []
  const toolCalls = rawCalls.map(normalizeToolCall).filter((call): call is ModelToolCall => Boolean(call))
  const hostedToolCalls = (Array.isArray(response.hostedToolCalls) ? response.hostedToolCalls : [])
    .map(normalizeHostedToolCall)
    .filter((call): call is ModelHostedToolCall => Boolean(call))
  const hostedSearchSources = (Array.isArray(response.hostedSearchSources) ? response.hostedSearchSources : [])
    .map(item => {
      const source = isRecord(item) ? item : {}
      return { title: text(source.title), url: text(source.url) }
    })
    .filter((item): item is ModelSearchSource => /^https?:\/\//i.test(item.url))
  const raw = isRecord(response.raw) ? response.raw : {}
  const stopReason = normalizeModelStopReason(
    response.stopReason ?? response.stop_reason ?? response.finishReason ?? response.finish_reason
      ?? raw.stopReason ?? raw.stop_reason ?? raw.finishReason ?? raw.finish_reason,
    toolCalls.length,
  )
  return {
    id: text(response.id).trim() || `model-response-${Date.now()}`,
    text: normalizeText(response.text ?? response.content),
    toolCalls,
    ...(hostedToolCalls.length ? { hostedToolCalls } : {}),
    ...(hostedSearchSources.length ? { hostedSearchSources } : {}),
    ...(text(response.upstreamResponseId).trim() ? { upstreamResponseId: text(response.upstreamResponseId).trim() } : {}),
    ...(response.upstreamStateReset === true ? { upstreamStateReset: true } : {}),
    ...(isRecord(response.responsesStateRecovery)
      ? { responsesStateRecovery: response.responsesStateRecovery as unknown as ModelResponse["responsesStateRecovery"] }
      : {}),
    stopReason,
    usage: normalizeModelUsage(response.usage || response.usageMetadata || {}),
    ...(isRecord(response.protocol) && Array.isArray(response.protocol.outputItems)
      ? { protocol: { kind: text(response.protocol.kind), outputItems: response.protocol.outputItems } }
      : {}),
    ...(Object.hasOwn(response, "raw") ? { raw: response.raw } : {}),
  }
}

/** 将内部消息片段转成模型适配器可理解的简短文本，媒体只保留引用信息。 */
export function contentPartToText(part: ContentPart): string {
  switch (part.type) {
    case "text": return part.text
    case "json": return JSON.stringify(part.data)
    case "mention": return `@${part.userId}`
    case "reply": return part.selectedText ? `引用：${part.selectedText}` : `回复消息：${part.messageId}`
    case "image": return `[图片 ${part.source.value}]`
    case "audio": return `[语音 ${part.source.value}]`
    case "video": return `[视频 ${part.source.value}]`
    case "file": return `[文件 ${part.source.value}]`
    case "music": return part.platform === "custom"
      ? `[音乐 ${part.title || part.url || part.audio || "自定义卡片"}${part.singer ? ` - ${part.singer}` : ""}]`
      : `[音乐 ${part.platform}/${part.id}]`
    case "forward": return `[合并转发 ${part.nodes.length} 条]`
    case "resource": return `[资源 ${part.uri}]`
    case "extension": return `[${part.namespace}:${part.name}]`
  }
}
