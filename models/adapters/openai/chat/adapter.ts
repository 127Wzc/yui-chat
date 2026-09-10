import crypto from "node:crypto"
import { fetchWithTimeout } from "../../../../core/network/fetch-timeout.js"
import { consumeServerSentEvents } from "../../sse.js"
import { applyReasoningPayload } from "../../../configuration/reasoning.js"
import { modelToolDefinition } from "../../../../tools/support/contract.js"
import { ModelAdapter, contentToText, messagesForOpenAI, normalizeListedModels, notifyModelRequest, parseDataUrl, parseResponseData, safeJson, tokenUsage } from "../../base.js"
import type { JsonValue } from "../../../../core/message-chain/types.js"
import type { GeneratedImage, ImageGenerationRequest, ImageGenerationResponse, ModelChannel, ModelRequest, ModelResponse } from "../../../protocol/types.js"
import type { ToolDefinition } from "../../../../tools/support/tool-contract.js"
import { normalizeModelStopReason } from "../../../protocol/normalize.js"

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
  const result = new Error(stringValue(error.message || error.status || root.error || `HTTP ${status}`))
  Object.assign(result, {
    ...(status ? { status } : {}),
    ...(error.code || root.code ? { code: String(error.code || root.code) } : {}),
    ...(error.type ? { providerType: String(error.type) } : {}),
  })
  return result
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
  override readonly protocol: string = "chat-completions"
  override readonly supportsTools: boolean = true
  override readonly supportsVision: boolean = true
  override readonly supportsStreaming: boolean = true
  override readonly supportsEmbeddings: boolean = true

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

  async embedTexts({ channel, texts = [], dimensions = 0, signal, onRequest }: Parameters<ModelAdapter["embedTexts"]>[0]): ReturnType<ModelAdapter["embedTexts"]> {
    const embeddingConfig = record(record(channel.modelConfig).embedding)
    const body: UnknownRecord = { model: channel.model, input: texts, ...record(embeddingConfig.params) }
    if (dimensions && embeddingConfig.supportsDimensionOverride !== false) body.dimensions = dimensions
    notifyModelRequest(onRequest, this.protocol, body)
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

  override async sendMessage({ channel, messages, tools = [], toolChoice, maxTokens = 0, signal, onRequest }: ModelRequest): Promise<ModelResponse> {
    const body = applyReasoningPayload({ model: channel.model || "gpt-4o-mini", messages: messagesForOpenAI(messages as unknown as readonly UnknownRecord[]), ...channelRecord(channel, "params") }, channel)
    const stream = channel.stream === true
    if (stream) {
      body.stream = true
      const streamOptions = record(body.stream_options)
      body.stream_options = { ...streamOptions, include_usage: streamOptions.include_usage !== false }
    }
    const tokenLimit = Math.max(0, Number(maxTokens) || 0)
    if (tokenLimit) {
      const completionTokens = Object.hasOwn(body, "max_completion_tokens") || (this.id === "openai-compatible" && /^(?:o[1-9]|gpt-5)(?:[-_]|$)/i.test(channel.model || ""))
      if (completionTokens) {
        delete body.max_tokens
        body.max_completion_tokens = tokenLimit
      } else body.max_tokens = tokenLimit
    }
    if (tools.length) {
      body.tools = tools.map((tool: ToolDefinition) => modelToolDefinition(tool))
      if (toolChoice && toolChoice !== "auto") {
        body.tool_choice = typeof toolChoice === "string"
          ? toolChoice
          : { type: "function", function: { name: toolChoice.name } }
      }
    }
    notifyModelRequest(onRequest, this.protocol, body)
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

function imageBytes(value: string): { bytes: Uint8Array; mimeType: string } | null {
  const parsed = parseDataUrl(value)
  if (!parsed) return null
  try {
    return { bytes: Uint8Array.from(Buffer.from(parsed.data, "base64")), mimeType: parsed.mediaType || "image/png" }
  } catch {
    return null
  }
}

function imageResult(value: UnknownRecord, allowBareUrl = true): GeneratedImage | null {
  const base64 = stringValue(value.b64_json || value.b64Json || value.base64)
  const data = stringValue(value.data)
  const rawUrl = stringValue(value.url)
  const dataUrl = /^data:image\//i.test(rawUrl) ? rawUrl : ""
  const url = allowBareUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : ""
  const mimeType = stringValue(value.mime_type || value.mimeType || "image/png") || "image/png"
  if (/^data:image\//i.test(data)) return { data, mimeType: data.match(/^data:([^;,]+)/i)?.[1] || mimeType }
  if (dataUrl) return { data: dataUrl, mimeType: dataUrl.match(/^data:([^;,]+)/i)?.[1] || mimeType }
  if (base64) {
    const payload = base64.replace(/\s+/g, "")
    if (/^[A-Za-z0-9+/=_-]+$/.test(payload)) return { data: `data:${mimeType};base64,${payload}`, mimeType, ...(value.revised_prompt ? { revisedPrompt: stringValue(value.revised_prompt) } : {}) }
  }
  if (url) return { url, mimeType, ...(value.revised_prompt ? { revisedPrompt: stringValue(value.revised_prompt) } : {}) }
  return null
}

function imageResultFromPart(value: unknown): GeneratedImage | null {
  const item = record(value)
  const type = stringValue(item.type || item.kind).toLowerCase()
  const mimeType = stringValue(item.mime_type || item.mimeType || item.media_type || item.mediaType || "image/png") || "image/png"
  if (type === "image_url" || item.image_url !== undefined || item.imageUrl !== undefined) {
    const imageValue = item.image_url !== undefined ? item.image_url : item.imageUrl
    const image = typeof imageValue === "string" ? { url: imageValue } : record(imageValue)
    return imageResult({ ...image, mimeType: image.mimeType || mimeType }, true)
  }
  if (type.includes("image") || type === "inline_data" || type === "inlinedata") {
    const nested = record(item.inline_data || item.inlineData || item.image)
    if (nested.data || nested.base64 || nested.b64_json) return imageResult({ ...nested, mimeType: nested.mimeType || mimeType }, false)
    const direct = imageResult(item, false)
    if (direct) return direct
    // 部分 OpenAI-compatible 网关把裸 Base64 放在 image.data 中，而不是 b64_json。
    const rawData = stringValue(item.data).replace(/\s+/g, "")
    if (rawData && /^[A-Za-z0-9+/=_-]+$/.test(rawData) && !/^data:/i.test(rawData)) return { data: `data:${mimeType};base64,${rawData}`, mimeType }
  }
  return null
}

function imageResultsFromValue(value: unknown, allowBareUrl = true, depth = 0): GeneratedImage[] {
  if (depth > 7 || value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(item => imageResultsFromValue(item, allowBareUrl, depth + 1))
  if (typeof value === "string") {
    if (/^data:image\//i.test(value.trim())) return [{ data: value.trim(), mimeType: value.trim().match(/^data:([^;,]+)/i)?.[1] || "image/png" }]
    return []
  }
  const item = record(value)
  const partImage = imageResultFromPart(item)
  const direct = partImage || imageResult(item, allowBareUrl)
  if (direct) return [direct]
  const output: GeneratedImage[] = []
  for (const key of ["images", "image", "data", "output_images", "outputImages", "results", "result", "content", "parts", "inline_data", "inlineData"]) {
    if (item[key] === undefined) continue
    const nestedAllowUrl = allowBareUrl || ["images", "data", "output_images", "outputImages", "results", "result"].includes(key)
    output.push(...imageResultsFromValue(item[key], nestedAllowUrl, depth + 1))
  }
  return output
}

function uniqueImages(images: GeneratedImage[]): GeneratedImage[] {
  const seen = new Set<string>()
  return images.filter(image => {
    const key = stringValue(image.data || image.url)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 从网关返回的文本中提取 Markdown/HTML 图片，兼容只在正文里返回图片地址的实现。 */
function imageResultsFromText(value: unknown): GeneratedImage[] {
  const source = stringValue(value)
  if (!source) return []
  const images: GeneratedImage[] = []
  const markdown = /!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/gi
  for (const match of source.matchAll(markdown)) {
    const candidate = stringValue(match[1]).trim().replace(/^<|>$/g, "")
    if (/^data:image\//i.test(candidate)) images.push({ data: candidate, mimeType: candidate.match(/^data:([^;,]+)/i)?.[1] || "image/png" })
    else if (/^https?:\/\//i.test(candidate)) images.push({ url: candidate, mimeType: "image/png" })
  }
  const html = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
  for (const match of source.matchAll(html)) {
    const candidate = stringValue(match[1]).trim()
    if (/^data:image\//i.test(candidate)) images.push({ data: candidate, mimeType: candidate.match(/^data:([^;,]+)/i)?.[1] || "image/png" })
    else if (/^https?:\/\//i.test(candidate)) images.push({ url: candidate, mimeType: "image/png" })
  }
  return uniqueImages(images)
}

/** 兼容将图片放进 Chat Completions choices.message/content 的网关响应。 */
function imageResultsFromChatResponse(value: unknown): GeneratedImage[] {
  const root = record(value)
  const images: GeneratedImage[] = []
  const collect = (candidate: unknown, allowBareUrl = false): void => {
    images.push(...imageResultsFromValue(candidate, allowBareUrl))
    if (typeof candidate === "string") images.push(...imageResultsFromText(candidate))
  }
  for (const rawChoice of array(root.choices)) {
    const choice = record(rawChoice)
    const message = record(choice.message)
    const delta = record(choice.delta)
    collect(message.images, true)
    collect(message.image, true)
    collect(message.content, false)
    collect(delta.images, true)
    collect(delta.image, true)
    collect(delta.content, false)
  }
  collect(root.images, true)
  collect(root.data, true)
  collect(root.output, true)
  collect(root.output_images || root.outputImages, true)
  collect(root.output_text || root.outputText || root.text, false)
  return uniqueImages(images)
}

function textFromChatResponse(value: unknown): string {
  const root = record(value)
  const chunks: string[] = []
  for (const rawChoice of array(root.choices)) {
    const choice = record(rawChoice)
    const message = record(choice.message)
    const delta = record(choice.delta)
    const content = delta.content !== undefined ? delta.content : message.content
    const text = contentToText(content || "")
    if (text) chunks.push(text)
  }
  const fallback = stringValue(root.output_text || root.outputText || root.text)
  if (fallback && !chunks.includes(fallback)) chunks.push(fallback)
  return chunks.join("")
}

function imageResultsFromStreamValue(value: unknown): Array<{ index: number; image: GeneratedImage }> {
  const output: Array<{ index: number; image: GeneratedImage }> = []
  const visit = (candidate: unknown, fallbackIndex = output.length): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, index))
      return
    }
    const item = record(candidate)
    const direct = imageResultFromPart(item) || imageResult(item)
    if (direct) {
      const candidateIndex = item.index ?? item.image_index ?? item.imageIndex ?? item.partial_image_index ?? item.partialImageIndex
      const index = Number.isInteger(Number(candidateIndex)) ? Number(candidateIndex) : fallbackIndex
      output.push({ index, image: direct })
      return
    }
    for (const key of ["image", "partial_image", "partialImage", "result", "output", "delta", "data", "images", "choices", "message", "content", "parts"]) {
      if (item[key] !== undefined) visit(item[key], fallbackIndex)
    }
  }
  visit(value)
  return output
}

/** 解析 OpenAI Images 的 SSE；不同兼容网关可能把图片包在 result/data/output 中，统一收敛。 */
export async function parseOpenAIImageStreamResponse(response: Response): Promise<ImageGenerationResponse> {
  if (!response.ok) throw responseError(await readJsonResponse(response), response.status)
  const images = new Map<number, GeneratedImage>()
  let text = ""
  let chunks = 0
  let usage = tokenUsage({})
  await consumeServerSentEvents(response, ({ data: rawData }) => {
    const payload = rawData.trim()
    if (!payload || payload === "[DONE]") return
    let data: unknown
    try { data = JSON.parse(payload) } catch { throw new Error("上游返回了无法解析的 OpenAI 图片流") }
    chunks++
    for (const { index, image } of imageResultsFromStreamValue(data)) images.set(index, image)
    for (const [index, image] of imageResultsFromChatResponse(data).entries()) if (!images.has(index)) images.set(index, image)
    const root = record(data)
    const directText = stringValue(root.output_text || root.outputText || root.text)
    if (directText) {
      text += directText
      for (const image of imageResultsFromText(directText)) images.set(images.size, image)
    }
    if (root.usage) usage = tokenUsage(data)
    const choiceUsage = array(root.choices).map(record).find(choice => choice.usage !== undefined)?.usage
    if (choiceUsage) usage = tokenUsage({ usage: choiceUsage })
    if (array(root.choices).length) {
      const choice = record(array(root.choices)[0])
      const delta = record(choice.delta)
      const contentValue = delta.content
      const contentText = contentToText(contentValue || "")
      if (contentText) text += contentText
      for (const image of imageResultsFromText(contentValue)) images.set(images.size, image)
      if (contentValue === undefined && delta.text) {
        const deltaText = stringValue(delta.text)
        text += deltaText
        for (const image of imageResultsFromText(deltaText)) images.set(images.size, image)
      }
    }
  })
  // 某些兼容网关把 Markdown/HTML 图片地址拆在多个文本事件中；流结束后
  // 再对累计正文扫描一次，避免单个 chunk 不是完整链接时漏掉图片。
  for (const image of imageResultsFromText(text)) images.set(images.size, image)
  return {
    images: uniqueImages([...images.entries()].sort(([left], [right]) => left - right).map(([, image]) => image)),
    ...(text ? { text } : {}),
    usage,
    raw: { stream: true, chunks },
  }
}

/** OpenAI 图片接口适配器；文本对话和图片生成使用不同模型配置，避免混用同一任务。 */
export class OpenAIImagesAdapter extends OpenAICompatibleAdapter {
  override readonly id = "openai-images"
  override readonly protocol = "openai-images"
  override readonly supportsTools = false
  override readonly supportsVision = false
  override readonly supportsStreaming = true
  override readonly supportsEmbeddings = false
  override readonly supportsImageGeneration = true

  private buildImagesUrl(channel: ModelChannel, edit = false): URL {
    const baseURL = (channel.baseURL || this.getDefaultBaseURL()).replace(/\/$/, "")
    const suffix = /\/images$/i.test(baseURL) ? (edit ? "/edits" : "/generations") : `/images/${edit ? "edits" : "generations"}`
    const url = new URL(`${baseURL}${suffix}`)
    for (const [key, value] of Object.entries(channelRecord(channel, "query"))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    if (channel.authType === "query" && channel.apiKey) url.searchParams.set(String(channel.authQueryName || "api_key"), channel.apiKey)
    return url
  }

  private imageConfig(channel: ModelChannel): UnknownRecord {
    const modelConfig = record(channel.modelConfig)
    const image = record(modelConfig.image)
    const direct = Object.fromEntries(["size", "quality", "background", "output_format", "moderation"].filter(key => image[key] !== undefined).map(key => [key, image[key]]))
    return { ...record(channel.params), ...direct, ...record(image.params), ...record(channelRecord(channel, "image")) }
  }

  /** 兼容把生图/编辑统一放在 /chat/completions 的 OpenAI 风格网关。 */
  private async generateViaChatCompletions({ channel, prompt, references, count, imageConfig, stream, timeoutMs, signal, onRequest }: {
    channel: ModelChannel
    prompt: string
    references: ImageGenerationRequest["references"]
    count?: number
    imageConfig: UnknownRecord
    stream: boolean
    timeoutMs: number
    signal?: AbortSignal
    onRequest?: ImageGenerationRequest["onRequest"]
  }): Promise<ImageGenerationResponse> {
    const content: UnknownRecord[] = [{ type: "text", text: prompt }]
    for (const [index, reference] of (references || []).entries()) content.push({ type: "image_url", image_url: { url: reference.data, detail: "high" }, index })
    const fields: UnknownRecord = {
      ...imageConfig,
      model: channel.model || "gpt-image-1",
      messages: [{ role: "user", content }],
      modalities: imageConfig.modalities || ["text", "image"],
    }
    delete fields.protocol
    delete fields.imageProtocol
    delete fields.aspectRatio
    delete fields.imageSize
    if (count !== undefined && count > 1 && fields.n === undefined) fields.n = count
    if (stream) {
      fields.stream = true
      const streamOptions = record(fields.stream_options)
      fields.stream_options = { ...streamOptions, include_usage: streamOptions.include_usage !== false }
    }
    const redactedContent = [{ type: "text", text: prompt }, ...(references || []).map((reference, index) => ({ type: "image_url", image_url: { url: "[image omitted]", index, mimeType: reference.mimeType || "image/png" } }))]
    notifyModelRequest(onRequest, "openai-chat-completions", { ...fields, messages: [{ role: "user", content: redactedContent }] })
    return fetchWithTimeout(this.buildUrl(channel), {
      method: "POST",
      headers: this.buildHeaders(channel),
      body: JSON.stringify(fields),
      timeoutMs,
      signal,
      consume: async response => {
        const contentType = String(response.headers.get("content-type") || "").toLowerCase()
        if (stream && contentType.includes("text/event-stream")) return parseOpenAIImageStreamResponse(response)
        const data = await readJsonResponse(response)
        if (!response.ok) throw responseError(data, response.status)
        return { images: imageResultsFromChatResponse(data), text: textFromChatResponse(data), usage: tokenUsage(data), raw: data }
      },
    })
  }

  override async generateImages({ channel, prompt, references = [], count, size = "", quality = "", background = "", stream: requestedStream, timeoutMs: requestedTimeoutMs, signal, onRequest }: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const imageConfig = this.imageConfig(channel)
    const hasExplicitCount = count !== undefined && count !== null && Number.isFinite(Number(count))
    const safeCount = hasExplicitCount ? Math.max(1, Math.trunc(Number(count))) : undefined
    const stream = requestedStream === undefined ? channel.stream === true : requestedStream === true
    const legacyChatCompletionsAlias = channel.type === "openai-chat-completions"
      || stringValue(channel.adapter).trim() === "openai-chat-completions"
      || stringValue(record(channel.modelConfig).adapter).trim() === "openai-chat-completions"
    const imageProtocol = stringValue(
      record(record(channel.modelConfig).image).protocol
        || record(channelRecord(channel, "image")).protocol
        || (legacyChatCompletionsAlias ? "openai-chat-completions" : "openai-images"),
    )
    // 图片生成通常比文字请求慢；后台工具会继续等待，只有达到这个总时限才丢弃结果。
    const timeoutMs = Math.max(1000, Number(requestedTimeoutMs || record(record(channel.modelConfig).image).timeoutMs || channel.timeoutMs || 300000))
    if (imageProtocol === "openai-chat-completions") {
      const requestImageConfig = {
        ...imageConfig,
        ...(size ? { size } : {}),
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {}),
      }
      return this.generateViaChatCompletions({ channel, prompt, references, count: safeCount, imageConfig: requestImageConfig, stream, timeoutMs, signal, onRequest })
    }
    const fields: UnknownRecord = { ...imageConfig, model: channel.model || "gpt-image-1", prompt }
    delete fields.protocol
    delete fields.imageProtocol
    delete fields.aspectRatio
    delete fields.imageSize
    if (size) fields.size = size
    if (quality) fields.quality = quality
    if (background) fields.background = background
    if (safeCount !== undefined && safeCount > 1) fields.n = safeCount
    if (stream) fields.stream = true

    const edit = references.length > 0
    const redactedReferences = references.map((reference, index) => ({ index, mimeType: reference.mimeType || "image/png", bytes: Math.ceil(String(reference.data || "").length * 0.75) }))
    if (edit) {
      const FormDataCtor = (globalThis as unknown as { FormData?: typeof FormData }).FormData
      const BlobCtor = (globalThis as unknown as { Blob?: typeof Blob }).Blob
      if (!FormDataCtor || !BlobCtor) throw new Error("当前运行环境不支持 OpenAI 图片编辑所需的 FormData")
      const form = new FormDataCtor()
      form.append("model", String(fields.model))
      form.append("prompt", prompt)
      for (const [key, value] of Object.entries(fields)) {
        if (["model", "prompt"].includes(key) || value === undefined || value === null || value === "") continue
        form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value))
      }
      const imageField = references.length > 1 ? "image[]" : "image"
      for (const [index, reference] of references.entries()) {
        const decoded = imageBytes(reference.data)
        if (!decoded) throw new Error(`参考图 ${index + 1} 不是有效的 data URL`)
        form.append(imageField, new BlobCtor([decoded.bytes], { type: reference.mimeType || decoded.mimeType }), reference.name || `reference-${index + 1}.png`)
      }
      notifyModelRequest(onRequest, this.protocol, { ...fields, references: redactedReferences })
      return fetchWithTimeout(this.buildImagesUrl(channel, true), {
        method: "POST",
        headers: (() => {
          const headers = this.buildHeaders(channel)
          for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key]
          return headers
        })(),
        body: form,
        timeoutMs,
        signal,
        consume: async response => {
          const contentType = String(response.headers.get("content-type") || "").toLowerCase()
          if (stream && contentType.includes("text/event-stream")) return parseOpenAIImageStreamResponse(response)
          const data = await readJsonResponse(response)
          if (!response.ok) throw responseError(data, response.status)
          const images = imageResultsFromValue(data, true)
          return { images, text: stringValue(data.output_text || data.text), usage: tokenUsage(data), raw: data }
        },
      })
    }

    const body = { ...fields, ...(redactedReferences.length ? { references: redactedReferences } : {}) }
    notifyModelRequest(onRequest, this.protocol, body)
    return fetchWithTimeout(this.buildImagesUrl(channel), {
      method: "POST",
      headers: this.buildHeaders(channel),
      body: JSON.stringify(fields),
      timeoutMs,
      signal,
      consume: async response => {
        const contentType = String(response.headers.get("content-type") || "").toLowerCase()
        if (stream && contentType.includes("text/event-stream")) return parseOpenAIImageStreamResponse(response)
        const data = await readJsonResponse(response)
        if (!response.ok) throw responseError(data, response.status)
        const images = imageResultsFromValue(data, true)
        return { images, text: stringValue(data.output_text || data.text), usage: tokenUsage(data), raw: data }
      },
    })
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
