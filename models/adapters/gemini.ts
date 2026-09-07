import crypto from "node:crypto"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import { applyReasoningPayload } from "../configuration/reasoning.js"
import { getToolCommon, modelToolDescription } from "../../tools/support/contract.js"
import { ModelAdapter, contentParts, contentToText, normalizeListedModels, notifyModelRequest, parseDataUrl, parseResponseData, safeJson, tokenUsage } from "./base.js"
import type { ContentPart, JsonValue } from "../../core/message-chain/types.js"
import type { ModelChannel, ModelMessage, ModelRequest, ModelResponse } from "../protocol/types.js"
import type { ToolDefinition } from "../../tools/support/tool-contract.js"
import { normalizeModelStopReason } from "../protocol/normalize.js"

type UnknownRecord = Record<string, unknown>

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

function responseError(data: unknown, status: number): Error {
  const root = record(data)
  const error = record(root.error)
  const result = new Error(stringValue(error.message || error.status || root.error || `HTTP ${status}`))
  Object.assign(result, {
    ...(status ? { status } : {}),
    ...(error.code || root.code ? { code: String(error.code || root.code) } : {}),
    ...(error.status ? { providerStatus: String(error.status) } : {}),
  })
  return result
}

function toGeminiParts(content: unknown): UnknownRecord[] {
  const parts: UnknownRecord[] = []
  for (const value of contentParts(content)) {
    const part = record(value)
    if (part.type === "text") {
      if (part.text) parts.push({ text: stringValue(part.text) })
      continue
    }
    if (part.type === "image_url") {
      const image = record(part.image_url)
      const url = stringValue(image.url)
      const data = parseDataUrl(url)
      if (data) parts.push({ inlineData: { mimeType: data.mediaType, data: data.data } })
      else if (url) parts.push({ text: `[图片链接] ${url}` })
      continue
    }
    if (part.type === "image" || part.type === "audio" || part.type === "video") {
      const source = record(part.source)
      const inline = stringValue(source.inlineData)
      const inlineUrl = inline ? `data:${stringValue(source.mimeType || part.mimeType || "application/octet-stream")};base64,${inline}` : stringValue(source.value)
      const data = parseDataUrl(inlineUrl)
      if (data && (part.type === "image" || part.type === "audio")) {
        parts.push({ inlineData: { mimeType: data.mediaType, data: data.data } })
        continue
      }
    }
    const text = contentToText([part])
    if (text) parts.push({ text })
  }
  return parts.length ? parts : [{ text: "空消息" }]
}

function toolsToGeminiDeclarations(tools: readonly ToolDefinition[] = []): UnknownRecord[] {
  return tools.map(tool => {
    const common = getToolCommon(tool)
    return { name: tool.name, description: modelToolDescription(tool), parameters: common.parameters || { type: "object", properties: {} } }
  }).filter(tool => Boolean(tool.name))
}

interface ProviderMessage extends UnknownRecord {
  role?: string
  content?: unknown
}

function providerMessages(messages: readonly ModelMessage[]): ProviderMessage[] {
  return messages as unknown as ProviderMessage[]
}

/** 把内部模型消息转换成 Gemini 的 user/model/functionResponse 结构。 */
export function messagesToGeminiContents(messages: readonly ModelMessage[] | readonly ProviderMessage[] = []): UnknownRecord[] {
  return providerMessages(messages as readonly ModelMessage[]).filter(item => item.role !== "system").map(item => {
    if (item.role === "tool") {
      return {
        role: "user",
        parts: [{ functionResponse: { name: stringValue(item.name || item.tool_name || "tool_result"), response: { result: contentToText(item.content || "") } } }],
      }
    }
    const rawToolCalls = array(item.tool_calls || item.toolCalls)
    if (item.role === "assistant" && rawToolCalls.length) {
      const parts: UnknownRecord[] = []
      if (item.content) parts.push({ text: contentToText(item.content) })
      for (const rawCall of rawToolCalls) {
        const call = record(rawCall)
        const functionValue = record(call.function)
        const name = stringValue(functionValue.name || call.name)
        if (name) parts.push({ functionCall: { name, args: safeJson(functionValue.arguments || call.arguments) } })
      }
      return { role: "model", parts: parts.length ? parts : [{ text: "" }] }
    }
    return { role: item.role === "assistant" ? "model" : "user", parts: toGeminiParts(item.content || "") }
  })
}

/** 从 Gemini candidate 中提取 functionCall，并生成统一工具调用 ID。 */
export function parseGeminiToolCalls(data: unknown = {}): ModelResponse["toolCalls"] {
  const root = record(data)
  const candidates = array(root.candidates)
  const first = candidates.length ? record(candidates[0]) : {}
  const content = record(first.content)
  return array(content.parts).flatMap(part => {
    const functionCall = record(record(part).functionCall)
    const name = stringValue(functionCall.name)
    return name ? [{ id: crypto.randomUUID(), name, arguments: safeJson(functionCall.args) }] : []
  })
}

/**
 * Gemini 适配器，统一处理 generateContent、function calling、视觉输入和 embedding。
 *
 * API Key 仅在请求边界使用，正文和工具参数的生命周期由模型协议与日志层管理。
 */
export class GeminiAdapter extends ModelAdapter {
  override readonly id: string = "gemini"
  override readonly protocol = "gemini-generate-content"
  override readonly supportsTools = true
  override readonly supportsVision = true
  override readonly supportsEmbeddings = true

  buildModelsUrl(channel: ModelChannel): URL {
    if (!channel.apiKey) throw new Error("Gemini channel apiKey is required")
    const baseURL = (channel.baseURL || "https://generativelanguage.googleapis.com").replace(/\/$/, "")
    const url = new URL(`${baseURL}/v1beta/models`)
    url.searchParams.set("key", channel.apiKey)
    for (const [key, value] of Object.entries(record(channel.query))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    return url
  }

  override async sendMessage({ channel, messages, tools = [], toolChoice, maxTokens = 0, signal, onRequest }: ModelRequest): Promise<ModelResponse> {
    if (!channel.apiKey) throw new Error("Gemini channel apiKey is required")
    const baseURL = (channel.baseURL || "https://generativelanguage.googleapis.com").replace(/\/$/, "")
    const model = channel.model || "gemini-flash-latest"
    const system = messages.find(item => item.role === "system")?.content
    const generationConfig: UnknownRecord = { ...record(channel.params) }
    const tokenLimit = Math.max(0, Number(maxTokens) || 0)
    if (tokenLimit) generationConfig.maxOutputTokens = tokenLimit
    const functionDeclarations = toolsToGeminiDeclarations(tools)
    const body = applyReasoningPayload({
      contents: messagesToGeminiContents(messages),
      ...(system ? { systemInstruction: { parts: [{ text: contentToText(system) }] } } : {}),
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
      ...(functionDeclarations.length && toolChoice && toolChoice !== "auto" ? {
        toolConfig: {
          functionCallingConfig: typeof toolChoice === "string"
            ? { mode: toolChoice === "none" ? "NONE" : "ANY" }
            : { mode: "ANY", allowedFunctionNames: [toolChoice.name] },
        },
      } : {}),
      generationConfig,
    }, channel)
    notifyModelRequest(onRequest, this.protocol, body)
    const response = await fetchWithTimeout(`${baseURL}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(channel.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...stringRecord(channel.headers) },
      body: JSON.stringify(body),
      timeoutMs: channel.timeoutMs || 90000,
      signal,
    })
    const data = await readJsonResponse(response)
    if (!response.ok) throw responseError(data, response.status)
    const candidates = array(data.candidates)
    const first = candidates.length ? record(candidates[0]) : {}
    const content = record(first.content)
    const parts = array(content.parts).map(record)
    const toolCalls = parseGeminiToolCalls(data)
    return {
      id: crypto.randomUUID(),
      text: parts.map(part => stringValue(part.text || "")).join(""),
      raw: data,
      usage: tokenUsage(data, "gemini"),
      stopReason: normalizeModelStopReason(first.finishReason, toolCalls.length),
      toolCalls,
    }
  }

  override async embedTexts({ channel, texts = [], dimensions = 0, signal, onRequest }: { channel: ModelChannel; texts?: string[]; dimensions?: number; signal?: AbortSignal; onRequest?: Parameters<ModelAdapter["embedTexts"]>[0]["onRequest"] }): Promise<Awaited<ReturnType<ModelAdapter["embedTexts"]>>> {
    if (!channel.apiKey) throw new Error("Gemini channel apiKey is required")
    const baseURL = (channel.baseURL || "https://generativelanguage.googleapis.com").replace(/\/$/, "")
    const model = channel.model || "text-embedding-004"
    const embeddingConfig = record(record(channel.modelConfig).embedding)
    const body = {
      requests: texts.map(text => ({ model: `models/${model.replace(/^models\//, "")}`, content: { parts: [{ text }] }, ...(dimensions ? { outputDimensionality: dimensions } : {}) })),
      ...record(embeddingConfig.params),
    }
    notifyModelRequest(onRequest, this.protocol, body)
    const response = await fetchWithTimeout(`${baseURL}/v1beta/models/${model.replace(/^models\//, "")}:batchEmbedContents?key=${encodeURIComponent(channel.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...stringRecord(channel.headers) },
      body: JSON.stringify(body),
      timeoutMs: Number(embeddingConfig.timeoutMs || channel.timeoutMs || 30000),
      signal,
    })
    const data = await readJsonResponse(response)
    if (!response.ok) throw responseError(data, response.status)
    const vectors = array(data.embeddings).map(item => {
      const value = record(item)
      const embedding = record(value.embedding)
      return Array.isArray(value.values) ? value.values.map(Number).filter(Number.isFinite) : Array.isArray(embedding.values) ? embedding.values.map(Number).filter(Number.isFinite) : []
    })
    return { vectors, dimensions: Number(dimensions || vectors[0]?.length || 0), model, usage: tokenUsage(data, "gemini") }
  }

  override async listModels({ channel }: { channel: ModelChannel }): Promise<unknown[]> {
    const response = await fetchWithTimeout(this.buildModelsUrl(channel), { method: "GET", headers: stringRecord(channel.headers), timeoutMs: channel.timeoutMs || 90000 })
    const data = parseResponseData(response, await response.json().catch(async () => ({ error: await response.text() })))
    return normalizeListedModels(array(data.models).map(item => {
      const value = record(item)
      return { id: value.name, label: value.displayName, description: value.description, methods: value.supportedGenerationMethods || value.supported_generation_methods || [], raw: item }
    }))
  }
}

export type { ContentPart, JsonValue }
