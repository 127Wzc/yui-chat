import crypto from "node:crypto"
import { safeJson, tokenUsage } from "../../base.js"
import type { ModelHostedToolCall, ModelResponse, ModelSearchSource, ModelStopReason } from "../../../protocol/types.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
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
