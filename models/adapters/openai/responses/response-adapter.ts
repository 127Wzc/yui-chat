import crypto from "node:crypto"
import { safeJson, tokenUsage } from "../../base.js"
import { consumeServerSentEvents } from "../../sse.js"
import type { ModelHostedToolCall, ModelResponse, ModelSearchSource, ModelStopReason } from "../../../protocol/types.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function streamResponseError(data: unknown, status = 0): Error {
  const root = record(data)
  const error = record(root.error)
  const result = new Error(text(error.message || error.code || root.error || `HTTP ${status}`))
  Object.assign(result, {
    ...(status ? { status } : {}),
    ...(error.code || root.code ? { code: text(error.code || root.code) } : {}),
    ...(error.type ? { providerType: text(error.type) } : {}),
  })
  return result
}

function outputItems(data: UnknownRecord): UnknownRecord[] {
  return Array.isArray(data.output) ? data.output.map(record) : []
}

const hostedOutputTypes = new Set(["web_search_call", "file_search_call", "tool_search_call", "tool_search_output"])

function shortText(value: unknown, limit = 500): string {
  const result = text(value).trim()
  return result.length > limit ? `${result.slice(0, limit)}…` : result
}

function searchSources(items: UnknownRecord[]): ModelSearchSource[] {
  const sources = new Map<string, ModelSearchSource>()
  const add = (value: unknown): void => {
    const source = record(value)
    const citation = record(source.url_citation)
    const url = text(source.url || citation.url).trim()
    if (!/^https?:\/\//i.test(url)) return
    const title = shortText(source.title || citation.title || url, 300) || url
    if (!sources.has(url)) sources.set(url, { title, url })
  }
  for (const item of items) {
    const action = record(item.action)
    for (const value of Array.isArray(action.sources) ? action.sources : []) add(value)
    if (item.type !== "message") continue
    for (const partValue of Array.isArray(item.content) ? item.content : []) {
      const part = record(partValue)
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) add(annotation)
    }
  }
  return [...sources.values()].slice(0, 50)
}

/** 提取可审计摘要，并保留对应原始 output item 供有界、脱敏日志记录。 */
function hostedToolCalls(items: UnknownRecord[]): ModelHostedToolCall[] {
  return items.filter(item => hostedOutputTypes.has(text(item.type))).map(item => {
    const action = record(item.action)
    const args = safeJson(item.arguments)
    const query = shortText(item.query || action.query || args.query || args.goal)
    const queries = (Array.isArray(item.queries) ? item.queries : Array.isArray(action.queries) ? action.queries : [])
      .map(value => shortText(value))
      .filter(Boolean)
    const loadedTools = (Array.isArray(item.tools) ? item.tools : Array.isArray(item.loaded_tools) ? item.loaded_tools : [])
      .map(value => shortText(record(value).name || value))
      .filter(Boolean)
    const results = Array.isArray(item.results) ? item.results : Array.isArray(action.sources) ? action.sources : []
    const sources = searchSources([item])
    return {
      type: text(item.type),
      id: text(item.id || item.call_id),
      status: text(item.status || "unknown"),
      ...(item.execution ? { execution: text(item.execution) } : {}),
      ...(query ? { query } : {}),
      ...(queries.length ? { queries } : {}),
      ...(loadedTools.length ? { loadedTools } : {}),
      ...(results.length ? { resultCount: results.length } : {}),
      ...(sources.length ? { sources } : {}),
      raw: item,
    }
  })
}

function outputText(items: UnknownRecord[]): string {
  const parts = items
    .filter(item => item.type === "message")
    .flatMap(item => Array.isArray(item.content) ? item.content.map(record) : [])
    .filter(part => part.type === "output_text" || part.type === "text" || part.type === "refusal")
  const answer = parts.map(part => text(part.text || part.refusal)).join("")
  const files = new Map<string, string>()
  for (const part of parts) {
    for (const value of Array.isArray(part.annotations) ? part.annotations : []) {
      const annotation = record(value)
      const fileCitation = record(annotation.file_citation)
      const fileId = text(annotation.file_id || fileCitation.file_id).trim()
      const filename = text(annotation.filename || fileCitation.filename || fileId).trim()
      if (fileId || filename) files.set(fileId || filename, filename || fileId)
    }
  }
  const fileLines = [...files.values()].map(filename => `- ${filename}`)
  return [
    answer,
    fileLines.length ? `参考文件：\n${fileLines.join("\n")}` : "",
  ].filter(Boolean).join("\n\n")
}

function hasRefusal(items: UnknownRecord[]): boolean {
  return items.some(item => item.type === "message"
    && Array.isArray(item.content)
    && item.content.some(part => record(part).type === "refusal"))
}

function stopReason(data: UnknownRecord, items: UnknownRecord[], callCount: number): ModelStopReason {
  if (data.error || data.status === "failed" || data.status === "cancelled") return "error"
  if (data.status === "incomplete") {
    const reason = text(record(data.incomplete_details).reason).toLowerCase()
    return /max_(?:output_)?tokens|length/.test(reason) ? "max_tokens" : "pause_turn"
  }
  if (callCount) return "tool_calls"
  if (hasRefusal(items)) return "refusal"
  return data.status === "completed" ? "end_turn" : "unknown"
}

/** 将 Responses output items 收敛回现有 Agent Core 的统一响应。 */
export function parseResponsesResponse(data: unknown): ModelResponse {
  const response = record(data)
  const items = outputItems(response)
  const upstreamResponseId = text(response.id).trim()
  const toolCalls = items
    .filter(item => item.type === "function_call")
    .map(item => ({
      id: text(item.call_id || item.id) || crypto.randomUUID(),
      name: text(item.name),
      arguments: safeJson(item.arguments),
    }))
    .filter(call => call.name)
  return {
    id: upstreamResponseId || crypto.randomUUID(),
    text: outputText(items),
    toolCalls,
    hostedToolCalls: hostedToolCalls(items),
    hostedSearchSources: searchSources(items),
    ...(upstreamResponseId ? { upstreamResponseId } : {}),
    stopReason: stopReason(response, items, toolCalls.length),
    usage: tokenUsage(response),
    protocol: { kind: "responses", outputItems: items },
    raw: response,
  }
}

function outputIndex(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function streamItemKey(item: UnknownRecord = {}, index: number | null = null): string {
  const id = text(item.id).trim()
  if (id) return `id:${id}`
  if (index !== null) return `output:${index}`
  return `event:${crypto.randomUUID()}`
}

function contentText(item: UnknownRecord): string {
  return (Array.isArray(item.content) ? item.content : [])
    .map(value => record(value))
    .filter(value => value.type === "output_text" || value.type === "text")
    .map(value => text(value.text))
    .join("")
}

function ensureOutputText(item: UnknownRecord, value: string): UnknownRecord {
  if (!value) return item
  const content = Array.isArray(item.content) ? item.content.map(record) : []
  const part = content.find(value => value.type === "output_text" || value.type === "text")
  if (part) part.text = value
  else content.push({ type: "output_text", text: value })
  return { ...item, content }
}

function patchStreamOutput(
  output: readonly unknown[],
  eventItems: Map<string, UnknownRecord>,
  textDeltas: Map<string, string>,
  functionArguments: Map<string, string>,
): UnknownRecord[] {
  return output.map((raw, index) => {
    const item = record(raw)
    const key = streamItemKey(item, index)
    const eventItem = eventItems.get(key)
    let merged = eventItem ? { ...eventItem, ...item } : { ...item }
    const argumentsValue = functionArguments.get(key)
    if (merged.type === "function_call" && argumentsValue && !text(merged.arguments).trim()) merged.arguments = argumentsValue
    const delta = textDeltas.get(key)
    if (merged.type === "message" && delta && !contentText(merged)) merged = ensureOutputText(merged, delta)
    return merged
  })
}

/**
 * 解析 OpenAI Responses 的语义事件流。
 *
 * Responses 不返回 Chat Completions 的 choices/delta 结构，而是通过
 * response.output_text.delta、response.function_call_arguments.delta 以及
 * response.completed 等事件逐步构造 output items；这里先收敛成完整响应，
 * 再复用同一套 hosted tool、Function Call、reasoning 和 usage 归一化逻辑。
 */
export async function parseResponsesStreamResponse(response: Response): Promise<ModelResponse> {
  if (!response.ok) {
    const body = await response.text()
    let data: unknown = {}
    try { data = body ? JSON.parse(body) : {} } catch { data = { error: body } }
    throw streamResponseError(data, response.status)
  }

  const eventItems = new Map<string, UnknownRecord>()
  const eventOrder: string[] = []
  const outputIndexKeys = new Map<number, string>()
  const textDeltas = new Map<string, string>()
  const functionArguments = new Map<string, string>()
  let responseState: UnknownRecord = {}
  let eventCount = 0

  const resolveKey = (data: UnknownRecord, item: UnknownRecord = {}): string => {
    const itemId = text(item.id || data.item_id).trim()
    if (itemId) return `id:${itemId}`
    const index = outputIndex(data.output_index)
    if (index !== null && outputIndexKeys.has(index)) return outputIndexKeys.get(index) as string
    if (index !== null) {
      const key = `output:${index}`
      outputIndexKeys.set(index, key)
      return key
    }
    return streamItemKey(item)
  }

  const upsert = (item: UnknownRecord, index: number | null): string => {
    const key = streamItemKey(item, index)
    if (!eventItems.has(key)) eventOrder.push(key)
    eventItems.set(key, { ...(eventItems.get(key) || {}), ...item })
    if (index !== null) outputIndexKeys.set(index, key)
    return key
  }

  await consumeServerSentEvents(response, ({ event, data: rawData }) => {
    eventCount++
    const payload = rawData.trim()
    if (!payload || payload === "[DONE]") return
    let data: UnknownRecord
    try {
      const parsed: unknown = JSON.parse(payload)
      data = record(parsed)
    } catch {
      throw new Error("上游返回了无法解析的 Responses 流式数据")
    }
    const type = text(data.type || event).trim()
    if (type === "error" || data.error) throw streamResponseError(data, response.status)

    const nestedResponse = record(data.response)
    if (type === "response.created" || type === "response.in_progress") responseState = { ...responseState, ...nestedResponse }
    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      responseState = { ...responseState, ...(Object.keys(nestedResponse).length ? nestedResponse : data) }
    }
    if (data.usage || nestedResponse.usage) responseState.usage = data.usage || nestedResponse.usage

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = record(data.item)
      if (Object.keys(item).length) upsert(item, outputIndex(data.output_index))
      return
    }

    if (type === "response.output_text.delta" || type === "response.output_text.done") {
      const key = resolveKey(data)
      const delta = type.endsWith(".done") ? text(data.text) : text(data.delta)
      if (delta) textDeltas.set(key, type.endsWith(".done") ? delta : `${textDeltas.get(key) || ""}${delta}`)
      const item = eventItems.get(key) || { type: "message", role: "assistant", content: [] }
      eventItems.set(key, ensureOutputText(item, textDeltas.get(key) || ""))
      if (!eventOrder.includes(key)) eventOrder.push(key)
      return
    }

    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const key = resolveKey(data)
      const value = type.endsWith(".done") ? text(data.arguments) : text(data.delta)
      if (type.endsWith(".done")) functionArguments.set(key, value)
      else functionArguments.set(key, `${functionArguments.get(key) || ""}${value}`)
      const item = eventItems.get(key) || { type: "function_call", id: text(data.item_id), call_id: text(data.call_id) }
      eventItems.set(key, {
        ...item,
        type: "function_call",
        ...(text(data.item_id) ? { id: text(data.item_id) } : {}),
        ...(text(data.call_id) ? { call_id: text(data.call_id) } : {}),
        arguments: functionArguments.get(key) || "",
      })
      if (!eventOrder.includes(key)) eventOrder.push(key)
      return
    }
  })

  const completedOutput = Array.isArray(responseState.output) ? responseState.output : []
  const output = completedOutput.length
    ? patchStreamOutput(completedOutput, eventItems, textDeltas, functionArguments)
    : eventOrder.map(key => {
        const item = { ...(eventItems.get(key) || {}) }
        const argumentsValue = functionArguments.get(key)
        if (item.type === "function_call" && argumentsValue) item.arguments = argumentsValue
        const delta = textDeltas.get(key)
        return item.type === "message" && delta && !contentText(item) ? ensureOutputText(item, delta) : item
      }).filter(item => item.type)
  const data: UnknownRecord = { ...responseState, output }
  const parsed = parseResponsesResponse(data)
  return { ...parsed, raw: { stream: true, eventCount, status: text(data.status) || "unknown" } }
}
