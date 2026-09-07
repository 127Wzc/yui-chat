import crypto from "node:crypto"
import { fetchWithTimeout } from "../../core/network/fetch-timeout.js"
import { applyReasoningPayload } from "../configuration/reasoning.js"
import { getToolCommon, modelToolDescription } from "../../tools/support/contract.js"
import { ModelAdapter, contentParts, contentToText, normalizeListedModels, notifyModelRequest, parseDataUrl, parseResponseData, safeJson, tokenUsage } from "./base.js"
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
    ...(error.type ? { providerType: String(error.type) } : {}),
  })
  return result
}

function toClaudeContent(content: unknown): UnknownRecord[] {
  const blocks: UnknownRecord[] = []
  for (const value of contentParts(content)) {
    const part = record(value)
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: stringValue(part.text) })
      continue
    }
    if (part.type === "image_url") {
      const image = record(part.image_url)
      const url = stringValue(image.url)
      const data = parseDataUrl(url)
      if (data) blocks.push({ type: "image", source: { type: "base64", media_type: data.mediaType, data: data.data } })
      else if (/^https?:/i.test(url)) blocks.push({ type: "image", source: { type: "url", url } })
      else if (url) blocks.push({ type: "text", text: `[图片链接] ${url}` })
      continue
    }
    const text = contentToText([part])
    if (text) blocks.push({ type: "text", text })
  }
  return blocks.length ? blocks : [{ type: "text", text: "空消息" }]
}

function toolsToClaude(tools: readonly ToolDefinition[] = []): UnknownRecord[] {
  return tools.map(tool => {
    const common = getToolCommon(tool)
    return { name: tool.name, description: modelToolDescription(tool), input_schema: common.parameters || { type: "object", properties: {} } }
  }).filter(tool => Boolean(tool.name))
}

interface ProviderMessage extends UnknownRecord {
  role?: string
  content?: unknown
}

function providerMessages(messages: readonly ModelMessage[]): ProviderMessage[] {
  return messages as unknown as ProviderMessage[]
}

/** 把内部消息转换为 Claude 的 user/assistant/tool_result/tool_use 内容块。 */
export function messagesToClaudeMessages(messages: readonly ModelMessage[] | readonly ProviderMessage[] = []): UnknownRecord[] {
  return providerMessages(messages as readonly ModelMessage[]).filter(item => item.role !== "system").map(item => {
    if (item.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: stringValue(item.tool_call_id), content: contentToText(item.content || "") }] }
    }
    const rawToolCalls = array(item.tool_calls || item.toolCalls)
    if (item.role === "assistant" && rawToolCalls.length) {
      const content: UnknownRecord[] = []
      if (item.content) content.push({ type: "text", text: contentToText(item.content) })
      for (const rawCall of rawToolCalls) {
        const call = record(rawCall)
        const functionValue = record(call.function)
        const name = stringValue(functionValue.name || call.name)
        if (name) content.push({ type: "tool_use", id: stringValue(call.id) || crypto.randomUUID(), name, input: safeJson(functionValue.arguments || call.arguments) })
      }
      return { role: "assistant", content }
    }
    return { role: item.role === "assistant" ? "assistant" : "user", content: toClaudeContent(item.content || "") }
  })
}

/** 从 Claude content 中提取 tool_use，转为统一工具调用结构。 */
export function parseClaudeToolCalls(data: unknown = {}): ModelResponse["toolCalls"] {
  return array(record(data).content).flatMap(rawPart => {
    const part = record(rawPart)
    const name = stringValue(part.name)
    return part.type === "tool_use" && name ? [{ id: stringValue(part.id) || crypto.randomUUID(), name, arguments: safeJson(part.input) }] : []
  })
}

/**
 * Claude Messages 适配器。
 *
 * system、工具块和视觉块只在这里转换；执行策略、工具权限和最终回复不由供应商适配器决定。
 */
export class ClaudeAdapter extends ModelAdapter {
  override readonly id: string = "claude"
  override readonly protocol = "claude-messages"
  override readonly supportsTools = true
  override readonly supportsVision = true

  buildModelsUrl(channel: ModelChannel): URL {
    if (!channel.apiKey) throw new Error("Claude channel apiKey is required")
    const baseURL = (channel.baseURL || "https://api.anthropic.com/v1").replace(/\/$/, "")
    const url = new URL(`${baseURL}/models`)
    for (const [key, value] of Object.entries(record(channel.query))) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value))
    }
    return url
  }

  headers(channel: ModelChannel, { contentType = false }: { contentType?: boolean } = {}): Record<string, string> {
    const params = record(channel.params)
    return {
      ...(contentType ? { "Content-Type": "application/json" } : {}),
      "x-api-key": channel.apiKey || "",
      "anthropic-version": String(params.anthropicVersion || "2023-06-01"),
      ...stringRecord(channel.headers),
    }
  }

  override async sendMessage({ channel, messages, tools = [], toolChoice, maxTokens = 0, signal, onRequest }: ModelRequest): Promise<ModelResponse> {
    if (!channel.apiKey) throw new Error("Claude channel apiKey is required")
    const baseURL = (channel.baseURL || "https://api.anthropic.com/v1").replace(/\/$/, "")
    const systemValue = messages.find(item => item.role === "system")?.content
    const params = record(channel.params)
    const body = applyReasoningPayload({
      model: channel.model || "claude-3-5-haiku-latest",
      max_tokens: Math.max(1, Number(maxTokens) || Number(params.max_tokens || params.maxTokens) || 1024),
      ...(systemValue ? { system: contentToText(systemValue) } : {}),
      ...(tools.length ? { tools: toolsToClaude(tools) } : {}),
      ...(tools.length && toolChoice && toolChoice !== "auto" ? {
        tool_choice: typeof toolChoice === "string"
          ? toolChoice === "none"
            ? { type: "none" }
            : { type: "any" }
          : { type: "tool", name: toolChoice.name },
      } : {}),
      messages: messagesToClaudeMessages(messages),
    }, channel)
    notifyModelRequest(onRequest, this.protocol, body)
    const response = await fetchWithTimeout(`${baseURL}/messages`, {
      method: "POST",
      headers: this.headers(channel, { contentType: true }),
      body: JSON.stringify(body),
      timeoutMs: channel.timeoutMs || 90000,
      signal,
    })
    const data = await readJsonResponse(response)
    if (!response.ok) throw responseError(data, response.status)
    const content = array(data.content).map(record)
    const toolCalls = parseClaudeToolCalls(data)
    return {
      id: stringValue(data.id) || crypto.randomUUID(),
      text: content.map(part => stringValue(part.text || "")).join(""),
      raw: data,
      usage: tokenUsage(data, "claude"),
      stopReason: normalizeModelStopReason(data.stop_reason, toolCalls.length),
      toolCalls,
    }
  }

  override async listModels({ channel }: { channel: ModelChannel }): Promise<unknown[]> {
    const response = await fetchWithTimeout(this.buildModelsUrl(channel), { method: "GET", headers: this.headers(channel), timeoutMs: channel.timeoutMs || 90000 })
    const data = parseResponseData(response, await response.json().catch(async () => ({ error: await response.text() })))
    const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
    return normalizeListedModels(items.map(item => {
      const value = record(item)
      return { id: value.id || value.name, label: value.display_name || value.displayName, description: value.description, raw: item }
    }))
  }
}
