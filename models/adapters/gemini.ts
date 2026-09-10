import crypto from "node:crypto"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import { applyReasoningPayload } from "../configuration/reasoning.js"
import { getToolCommon, modelToolDescription } from "../../tools/support/contract.js"
import { ModelAdapter, contentParts, contentToText, normalizeListedModels, notifyModelRequest, parseDataUrl, parseResponseData, safeJson, tokenUsage } from "./base.js"
import { consumeServerSentEvents } from "./sse.js"
import type { ContentPart, JsonValue } from "../../core/message-chain/types.js"
import type { GeneratedImage, ImageGenerationRequest, ImageGenerationResponse, ModelChannel, ModelMessage, ModelRequest, ModelResponse } from "../protocol/types.js"
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

interface GeminiStreamFunctionCall {
  name: string
  arguments: UnknownRecord
  argumentText: string
}

interface GeminiStreamCandidate {
  text: string
  finishReason: string
  functions: Map<string, GeminiStreamFunctionCall>
}

function mergeGeminiArguments(target: UnknownRecord, value: unknown): { arguments: UnknownRecord; argumentText: string } {
  if (isRecord(value)) return { arguments: { ...target, ...value }, argumentText: "" }
  if (typeof value !== "string") return { arguments: target, argumentText: "" }
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? { arguments: { ...target, ...parsed }, argumentText: "" } : { arguments: target, argumentText: value }
  } catch {
    return { arguments: target, argumentText: value }
  }
}

/** 解析 Gemini streamGenerateContent 的 SSE chunks，并收敛为普通 GenerateContent 响应。 */
export async function parseGeminiStreamResponse(response: Response): Promise<ModelResponse> {
  if (!response.ok) {
    const body = await response.text()
    let data: unknown = {}
    try { data = body ? JSON.parse(body) : {} } catch { data = { error: body } }
    throw responseError(data, response.status)
  }
  const candidates = new Map<number, GeminiStreamCandidate>()
  let usage: UnknownRecord = {}
  let chunks = 0
  await consumeServerSentEvents(response, ({ data: rawData }) => {
    const payload = rawData.trim()
    if (!payload || payload === "[DONE]") return
    let data: UnknownRecord
    try {
      const parsed: unknown = JSON.parse(payload)
      data = record(parsed)
    } catch {
      throw new Error("上游返回了无法解析的 Gemini 流式数据")
    }
    chunks++
    if (data.error) throw responseError(data, response.status)
    if (isRecord(data.usageMetadata)) usage = { ...usage, ...data.usageMetadata }
    for (const [fallbackIndex, rawCandidate] of array(data.candidates).entries()) {
      const candidate = record(rawCandidate)
      const index = Number.isInteger(Number(candidate.index)) ? Number(candidate.index) : fallbackIndex
      const current = candidates.get(index) || { text: "", finishReason: "", functions: new Map() }
      const content = record(candidate.content)
      for (const rawPart of array(content.parts)) {
        const part = record(rawPart)
        if (part.text) current.text += stringValue(part.text)
        const functionCall = record(part.functionCall || part.function_call)
        const name = stringValue(functionCall.name).trim()
        if (name) {
          const existing = current.functions.get(name) || { name, arguments: {}, argumentText: "" }
          const merged = mergeGeminiArguments(existing.arguments, functionCall.args ?? functionCall.arguments)
          existing.arguments = merged.arguments
          if (merged.argumentText) {
            existing.argumentText += merged.argumentText
            const parsed = safeJson(existing.argumentText)
            if (Object.keys(parsed).length) {
              existing.arguments = { ...existing.arguments, ...parsed }
              existing.argumentText = ""
            }
          }
          current.functions.set(name, existing)
        }
      }
      const finishReason = stringValue(candidate.finishReason || candidate.finish_reason)
      if (finishReason) current.finishReason = finishReason
      candidates.set(index, current)
    }
  })
  const candidateItems = [...candidates.entries()].sort(([left], [right]) => left - right).map(([index, candidate]) => {
    const parts: UnknownRecord[] = []
    if (candidate.text) parts.push({ text: candidate.text })
    for (const functionCall of candidate.functions.values()) {
      const argumentsValue = Object.keys(functionCall.arguments).length
        ? functionCall.arguments
        : safeJson(functionCall.argumentText)
      parts.push({ functionCall: { name: functionCall.name, args: argumentsValue } })
    }
    return {
      index,
      content: { role: "model", parts },
      ...(candidate.finishReason ? { finishReason: candidate.finishReason } : {}),
    }
  })
  const data = { candidates: candidateItems, ...(Object.keys(usage).length ? { usageMetadata: usage } : {}) }
  const first = candidateItems[0] || {}
  const firstParts = array(record(first.content).parts).map(record)
  const parsed = {
    id: crypto.randomUUID(),
    text: firstParts.map(part => stringValue(part.text || "")).join(""),
    raw: { stream: true, chunks, finishReason: first.finishReason || "" },
    usage: tokenUsage(data, "gemini"),
    stopReason: normalizeModelStopReason(first.finishReason, parseGeminiToolCalls(data).length),
    toolCalls: parseGeminiToolCalls(data),
  }
  return parsed
}

/** 解析 Gemini 图片模型的 streamGenerateContent SSE，并收敛为最终图片数组。 */
export async function parseGeminiImageStreamResponse(response: Response): Promise<ImageGenerationResponse> {
  if (!response.ok) {
    const body = await response.text()
    let data: unknown = {}
    try { data = body ? JSON.parse(body) : {} } catch { data = { error: body } }
    throw responseError(data, response.status)
  }
  const images = new Map<string, GeneratedImage>()
  let text = ""
  let usage: UnknownRecord = {}
  let chunks = 0
  await consumeServerSentEvents(response, ({ data: rawData }) => {
    const payload = rawData.trim()
    if (!payload || payload === "[DONE]") return
    let data: UnknownRecord
    try {
      const parsed: unknown = JSON.parse(payload)
      data = record(parsed)
    } catch {
      throw new Error("上游返回了无法解析的 Gemini 图片流")
    }
    chunks++
    if (isRecord(data.usageMetadata)) usage = { ...usage, ...data.usageMetadata }
    for (const [candidateIndex, rawCandidate] of array(data.candidates).entries()) {
      const candidate = record(rawCandidate)
      const candidateKey = Number.isInteger(Number(candidate.index)) ? Number(candidate.index) : candidateIndex
      const content = record(candidate.content)
      for (const [partIndex, rawPart] of array(content.parts).entries()) {
        const part = record(rawPart)
        if (part.text) text += stringValue(part.text)
        const inline = record(part.inlineData || part.inline_data)
        const encoded = stringValue(inline.data)
        if (!encoded) continue
        const mimeType = stringValue(inline.mimeType || inline.mime_type || "image/png") || "image/png"
        images.set(`${candidateKey}:${partIndex}`, { data: `data:${mimeType};base64,${encoded}`, mimeType })
      }
    }
  })
  return {
    images: [...images.values()],
    ...(text ? { text } : {}),
    usage: tokenUsage({ usageMetadata: usage }, "gemini"),
    raw: { stream: true, chunks },
  }
}

/**
 * Gemini 适配器，统一处理 generateContent、function calling、视觉输入和 embedding。
 *
 * API Key 仅在请求边界使用，正文和工具参数的生命周期由模型协议与日志层管理。
 */
export class GeminiAdapter extends ModelAdapter {
  override readonly id: string = "gemini"
  override readonly protocol: string = "gemini-generate-content"
  override readonly supportsTools: boolean = true
  override readonly supportsVision: boolean = true
  override readonly supportsStreaming: boolean = true
  override readonly supportsEmbeddings: boolean = true

  override async generateImages({ channel, prompt, references = [], count, aspectRatio = "", imageSize = "", stream: requestedStream, timeoutMs: requestedTimeoutMs, signal, onRequest }: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    if (!channel.apiKey) throw new Error("Gemini channel apiKey is required")
    const baseURL = (channel.baseURL || "https://generativelanguage.googleapis.com").replace(/\/$/, "")
    const model = channel.model || "gemini-2.0-flash-preview-image-generation"
    const image = record(record(channel.modelConfig).image)
    const configuredAspectRatio = stringValue(image.aspectRatio)
    const configuredImageSize = stringValue(image.imageSize)
    const imageConfig = { ...record(channel.params), ...record(image.params) }
    delete imageConfig.aspectRatio
    delete imageConfig.imageSize
    const hasExplicitCount = count !== undefined && count !== null && Number.isFinite(Number(count))
    const safeCount = hasExplicitCount ? Math.max(1, Math.trunc(Number(count))) : undefined
    const resolvedAspectRatio = aspectRatio || configuredAspectRatio
    const resolvedImageSize = imageSize || configuredImageSize
    const stream = requestedStream === undefined ? channel.stream === true : requestedStream === true
    const config: UnknownRecord = {
      ...imageConfig,
      responseModalities: ["IMAGE"],
      ...(safeCount !== undefined && safeCount > 1 && imageConfig.candidateCount === undefined ? { candidateCount: safeCount } : {}),
      ...(resolvedAspectRatio || resolvedImageSize ? { imageConfig: { ...record(imageConfig.imageConfig), ...(resolvedAspectRatio ? { aspectRatio: resolvedAspectRatio } : {}), ...(resolvedImageSize ? { imageSize: resolvedImageSize } : {}) } } : {}),
    }
    // 参考图只保留脱敏摘要进入日志；正文仍按 inlineData 交给 Gemini。
    const parts: UnknownRecord[] = [{ text: prompt }]
    for (const [index, reference] of references.entries()) {
      const parsed = parseDataUrl(reference.data)
      if (!parsed) throw new Error(`参考图 ${index + 1} 不是有效的 data URL`)
      parts.push({ inlineData: { mimeType: reference.mimeType || parsed.mediaType || "image/png", data: parsed.data } })
    }
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: config,
    }
    notifyModelRequest(onRequest, "gemini-image-generation", {
      contents: [{ role: "user", parts: [{ text: prompt }, ...references.map((reference, index) => ({ inlineData: { index, mimeType: reference.mimeType || "image/png", bytes: Math.ceil(String(reference.data || "").length * 0.75) } }))] }],
      generationConfig: config,
    })
    const endpoint = stream ? "streamGenerateContent" : "generateContent"
    const url = new URL(`${baseURL}/v1beta/models/${model.replace(/^models\//, "")}:${endpoint}`)
    if (stream) url.searchParams.set("alt", "sse")
    url.searchParams.set("key", channel.apiKey)
    for (const [key, value] of Object.entries(record(channel.query))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    return fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...stringRecord(channel.headers) },
      body: JSON.stringify(body),
      // 图片生成通常比文字请求慢；后台工具会继续等待，只有达到这个总时限才丢弃结果。
      timeoutMs: Math.max(1000, Number(requestedTimeoutMs || record(record(channel.modelConfig).image).timeoutMs || channel.timeoutMs || 300000)),
      signal,
      consume: async response => {
        const contentType = String(response.headers.get("content-type") || "").toLowerCase()
        if (stream && contentType.includes("text/event-stream")) return parseGeminiImageStreamResponse(response)
        const data = await readJsonResponse(response)
        if (!response.ok) throw responseError(data, response.status)
        const images: GeneratedImage[] = []
        const textParts: string[] = []
        for (const rawCandidate of array(data.candidates)) {
          const content = record(record(rawCandidate).content)
          for (const part of array(content.parts).map(record)) {
            if (part.text) textParts.push(stringValue(part.text))
            const inline = record(part.inlineData || part.inline_data)
            const encoded = stringValue(inline.data)
            if (!encoded) continue
            const mimeType = stringValue(inline.mimeType || inline.mime_type || "image/png") || "image/png"
            images.push({ data: `data:${mimeType};base64,${encoded}`, mimeType })
          }
        }
        const text = textParts.join("")
        return { images, ...(text ? { text } : {}), usage: tokenUsage(data, "gemini"), raw: data }
      },
    })
  }

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
    const endpoint = channel.stream === true ? "streamGenerateContent" : "generateContent"
    const url = new URL(`${baseURL}/v1beta/models/${model.replace(/^models\//, "")}:${endpoint}`)
    if (channel.stream === true) url.searchParams.set("alt", "sse")
    url.searchParams.set("key", channel.apiKey)
    for (const [key, value] of Object.entries(record(channel.query))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    return fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...stringRecord(channel.headers) },
      body: JSON.stringify(body),
      timeoutMs: channel.timeoutMs || 90000,
      signal,
      consume: async response => {
        const contentType = String(response.headers.get("content-type") || "").toLowerCase()
        if (channel.stream === true && contentType.includes("text/event-stream")) return parseGeminiStreamResponse(response)
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
      },
    })
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

/** Gemini 图片专用模型入口，和文本 Gemini 渠道分开出现在任务路由中。 */
export class GeminiImagesAdapter extends GeminiAdapter {
  override readonly id = "gemini-images"
  override readonly protocol = "gemini-image-generation"
  override readonly supportsTools = false
  override readonly supportsVision = false
  override readonly supportsStreaming = true
  override readonly supportsEmbeddings = false
  override readonly supportsImageGeneration = true
}

export type { ContentPart, JsonValue }
