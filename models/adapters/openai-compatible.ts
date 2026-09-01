import crypto from "node:crypto"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import { applyReasoningPayload } from "../configuration/reasoning.js"
import { getToolCommon } from "../../tools/support/contract.js"
import { ModelAdapter, contentToText, messagesForOpenAI, normalizeListedModels, parseResponseData, safeJson, tokenUsage } from "./base.js"
import type { JsonValue } from "../../core/message-chain/types.js"
import type { ModelChannel, ModelRequest, ModelResponse } from "../protocol/types.js"
import type { ToolDefinition } from "../../tools/support/tool-contract.js"
import { normalizeModelStopReason } from "../protocol/normalize.js"

type UnknownRecord = Record<string, unknown>

interface StreamToolCall {
  id: string
  name: string
  arguments: string
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, String(item)]))
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(Number.isFinite) : []
}

async function readJsonResponse(response: Response): Promise<UnknownRecord> {
  const text = await response.text()
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : { error: parsed }
  } catch {
    return { error: text }
  }
}

function responseError(data: unknown, status = 0): Error {
  const root = record(data)
  const error = record(root.error)
  return new Error(stringValue(error.message || error.status || root.error || `HTTP ${status}`))
}

function mergeStreamToolCalls(target: Map<number, StreamToolCall>, deltas: readonly unknown[]): void {
  for (const value of deltas) {
    const delta = record(value)
    const index = Number.isInteger(delta.index) ? Number(delta.index) : target.size
    const current = target.get(index) || { id: "", name: "", arguments: "" }
    if (delta.id) current.id = stringValue(delta.id)
    const functionValue = record(delta.function)
    if (functionValue.name) current.name += stringValue(functionValue.name)
    if (functionValue.arguments) current.arguments += stringValue(functionValue.arguments)
    target.set(index, current)
  }
}

/** 解析 OpenAI-compatible SSE；工具调用参数按 index 增量拼接后再交给统一协议。 */
export async function parseOpenAIStreamResponse(response: Response): Promise<ModelResponse> {
  if (!response.ok) throw responseError(await readJsonResponse(response), response.status)
  if (!response.body) throw new Error("流式响应没有可读取的正文")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const toolCalls = new Map<number, StreamToolCall>()
  let buffer = ""
  let text = ""
  let id = ""
  let usage = tokenUsage({})
  let chunks = 0
  let finishReason = ""

  const consumeLine = (line: string): boolean => {
    const trimmed = String(line || "").trim()
    if (!trimmed.startsWith("data:")) return false
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === "[DONE]") return payload === "[DONE]"
    let data: UnknownRecord
    try {
      const parsed: unknown = JSON.parse(payload)
      data = record(parsed)
    } catch {
      throw new Error("上游返回了无法解析的流式数据")
    }
    if (data.error) throw responseError(data, response.status)
    chunks++
    if (!id && data.id) id = stringValue(data.id)
    if (data.usage) usage = tokenUsage(data)
    const choice = array(data.choices).length ? record(array(data.choices)[0]) : {}
    const delta = record(choice.delta)
    text += contentToText(delta.content || "")
    mergeStreamToolCalls(toolCalls, array(delta.tool_calls))
    if (choice.finish_reason) finishReason = stringValue(choice.finish_reason)
    return false
  }

  let done = false
  while (!done) {
    const part = await reader.read()
    buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
    const lines = buffer.split(/\r?\n/)
    buffer = part.done ? "" : lines.pop() || ""
    for (const line of lines) {
      if (consumeLine(line)) {
        done = true
        break
      }
    }
    if (part.done) {
      if (buffer) consumeLine(buffer)
      break
    }
  }

  return {
    id: id || crypto.randomUUID(),
    text,
    raw: { stream: true, chunks, finishReason },
    usage,
    stopReason: normalizeModelStopReason(finishReason, toolCalls.size),
    toolCalls: [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id || crypto.randomUUID(),
        name: call.name,
        arguments: safeJson(call.arguments),
      }))
      .filter(call => call.name),
  }
}

function channelRecord(channel: ModelChannel, key: string): UnknownRecord {
  return record(channel[key])
}

/**
 * OpenAI-compatible 适配器，Qwen 和 ChatGLM 只复用协议转换并覆盖默认地址。
 *
 * 该类只负责 HTTP 和供应商字段映射，不决定工具权限、执行次数或最终回复策略。
 */
export class OpenAICompatibleAdapter extends ModelAdapter {
  override readonly id: string = "openai-compatible"
  override readonly supportsTools = true
  override readonly supportsVision = true
  override readonly supportsStreaming = true
  override readonly supportsEmbeddings = true

  getDefaultBaseURL(): string { return "https://api.openai.com/v1" }

  buildUrl(channel: ModelChannel): URL {
    const baseURL = (channel.baseURL || this.getDefaultBaseURL()).replace(/\/$/, "")
    const url = new URL(`${baseURL}/chat/completions`)
    for (const [key, value] of Object.entries(channelRecord(channel, "query"))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    if (channel.authType === "query" && channel.apiKey) url.searchParams.set(String(channel.authQueryName || "api_key"), channel.apiKey)
    return url
  }

  buildModelsUrl(channel: ModelChannel): URL {
    const baseURL = (channel.baseURL || this.getDefaultBaseURL()).replace(/\/$/, "")
    const url = new URL(`${baseURL}/models`)
    for (const [key, value] of Object.entries(channelRecord(channel, "query"))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    if (channel.apiKey && channel.authType === "query") url.searchParams.set(String(channel.authQueryName || "api_key"), channel.apiKey)
    return url
  }

  buildEmbeddingsUrl(channel: ModelChannel): URL {
    const baseURL = (channel.baseURL || this.getDefaultBaseURL()).replace(/\/$/, "")
    const url = new URL(`${baseURL}/embeddings`)
    for (const [key, value] of Object.entries(channelRecord(channel, "query"))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    if (channel.apiKey && channel.authType === "query") url.searchParams.set(String(channel.authQueryName || "api_key"), channel.apiKey)
    return url
  }

  async embedTexts({ channel, texts = [], dimensions = 0, signal }: Parameters<ModelAdapter["embedTexts"]>[0]): ReturnType<ModelAdapter["embedTexts"]> {
    const embeddingConfig = record(record(channel.modelConfig).embedding)
    const body: UnknownRecord = { model: channel.model, input: texts, ...record(embeddingConfig.params) }
    if (dimensions && embeddingConfig.supportsDimensionOverride !== false) body.dimensions = dimensions
    return fetchWithTimeout(this.buildEmbeddingsUrl(channel), {
      method: "POST",
      headers: this.buildHeaders(channel),
      body: JSON.stringify(body),
      timeoutMs: Number(embeddingConfig.timeoutMs || channel.timeoutMs || 30000),
      signal,
      consume: async response => {
        const data = await readJsonResponse(response)
        if (!response.ok) throw responseError(data, response.status)
        const items = array(data.data).map(record).sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
        const vectors = items.map(item => numberArray(item.embedding))
        return {
          vectors,
          dimensions: Number(dimensions || vectors[0]?.length || 0),
          model: stringValue(data.model || channel.model),
          usage: tokenUsage(data),
        }
      },
    })
  }

  buildHeaders(channel: ModelChannel): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...stringRecord(channel.headers) }
    if (!channel.apiKey || channel.authType === "none" || channel.authType === "query") return headers
    const authHeader = String(channel.authHeader || "Authorization")
    if (channel.authType === "x-api-key") headers["x-api-key"] = channel.apiKey
    else if (channel.authType === "api-key") headers["api-key"] = channel.apiKey
    else if (channel.authType === "custom-header") headers[authHeader] = channel.apiKey
    else headers[authHeader] = `Bearer ${channel.apiKey}`
    return headers
  }

  override async sendMessage({ channel, messages, tools = [], toolChoice, maxTokens = 0, signal }: ModelRequest): Promise<ModelResponse> {
    const body = applyReasoningPayload({ model: channel.model || "gpt-4o-mini", messages: messagesForOpenAI(messages as unknown as readonly UnknownRecord[]), ...channelRecord(channel, "params") }, channel)
    const stream = channel.stream === true
    if (stream) body.stream = true
    const tokenLimit = Math.max(0, Number(maxTokens) || 0)
    if (tokenLimit) {
      const completionTokens = Object.hasOwn(body, "max_completion_tokens") || (this.id === "openai-compatible" && /^(?:o[1-9]|gpt-5)(?:[-_]|$)/i.test(channel.model || ""))
      if (completionTokens) {
        delete body.max_tokens
        body.max_completion_tokens = tokenLimit
      } else body.max_tokens = tokenLimit
    }
    if (tools.length) {
      body.tools = tools.map((tool: ToolDefinition) => {
        const common = getToolCommon(tool)
        return { type: "function", function: { name: tool.name, description: common.description, parameters: common.parameters || { type: "object", properties: {} } } }
      })
      if (toolChoice && toolChoice !== "auto") {
        body.tool_choice = typeof toolChoice === "string"
          ? toolChoice
          : { type: "function", function: { name: toolChoice.name } }
      }
    }
    return fetchWithTimeout(this.buildUrl(channel), {
      method: "POST",
      headers: this.buildHeaders(channel),
      body: JSON.stringify(body),
      timeoutMs: channel.timeoutMs || 90000,
      signal,
      consume: async response => {
        const contentType = String(response.headers.get("content-type") || "").toLowerCase()
        if (stream && contentType.includes("text/event-stream")) return parseOpenAIStreamResponse(response)
        const data = await readJsonResponse(response)
        if (!response.ok) throw responseError(data, response.status)
        const choice = array(data.choices).length ? record(array(data.choices)[0]) : {}
        const message = record(choice.message)
        const rawCalls = array(message.tool_calls)
        return {
          id: stringValue(data.id) || crypto.randomUUID(),
          text: contentToText(message.content || ""),
          raw: data,
          usage: tokenUsage(data),
          stopReason: normalizeModelStopReason(choice.finish_reason, rawCalls.length),
          toolCalls: rawCalls.map(call => {
            const value = record(call)
            const functionValue = record(value.function)
            const name = stringValue(functionValue.name)
            return { id: stringValue(value.id) || crypto.randomUUID(), name, arguments: safeJson(functionValue.arguments) }
          }).filter(call => call.name),
        }
      },
    })
  }

  override async listModels({ channel }: { channel: ModelChannel }): Promise<unknown[]> {
    const response = await fetchWithTimeout(this.buildModelsUrl(channel), { method: "GET", headers: this.buildHeaders(channel), timeoutMs: channel.timeoutMs || 90000 })
    const data = parseResponseData(response, await response.json().catch(async () => ({ error: await response.text() })))
    return normalizeListedModels(array(data.data).map(item => ({ id: record(item).id, ownedBy: record(item).owned_by, raw: item })))
  }
}

export class QwenAdapter extends OpenAICompatibleAdapter {
  override readonly id = "qwen"
  override getDefaultBaseURL(): string { return "https://dashscope.aliyuncs.com/compatible-mode/v1" }
}

export class ChatGLMAdapter extends OpenAICompatibleAdapter {
  override readonly id = "chatglm"
  override getDefaultBaseURL(): string { return "https://open.bigmodel.cn/api/paas/v4" }
}

export type { JsonValue }
