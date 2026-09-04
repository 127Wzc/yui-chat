import { applyReasoningPayload } from "../../../configuration/reasoning.js"
import { responsesUsesUpstreamState, type ResponsesStateMode } from "../../../configuration/responses-state.js"
import { contentToText } from "../../base.js"
import { responsesToolDefinition } from "../../../../tools/support/contract.js"
import type { ModelChannel, ModelMessage, ModelToolChoice } from "../../../protocol/types.js"
import type { ToolDefinition } from "../../../../tools/support/tool-contract.js"

type UnknownRecord = Record<string, unknown>

export interface ResponsesRequestInput {
  channel: ModelChannel
  messages: ModelMessage[]
  replayMessages?: ModelMessage[]
  tools?: ToolDefinition[]
  toolChoice?: ModelToolChoice
  maxTokens?: number
}

export interface ResponsesRecoveryRequest {
  body: UnknownRecord
  replayedMessages: number
  droppedToolItems: number
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).map(item => item.trim()).filter(Boolean))] : []
}

function responseContent(content: unknown, role: string): unknown {
  if (!Array.isArray(content)) return content ?? ""
  const textType = role === "assistant" ? "output_text" : "input_text"
  const result: UnknownRecord[] = []
  for (const value of content) {
    const part = record(value)
    if (part.type === "text") {
      result.push({ type: textType, text: text(part.text) })
      continue
    }
    if (part.type === "image_url") {
      const image = record(part.image_url)
      if (image.url) result.push({ type: "input_image", image_url: text(image.url), ...(image.detail ? { detail: text(image.detail) } : {}) })
      continue
    }
    if (part.type === "image") {
      const source = record(part.source)
      const inline = text(source.inlineData)
      const imageUrl = inline ? `data:${text(source.mimeType || part.mimeType || "image/png")};base64,${inline}` : text(source.value)
      if (imageUrl) result.push({ type: "input_image", image_url: imageUrl })
      continue
    }
    const summary = contentToText([part])
    if (summary) result.push({ type: textType, text: summary })
  }
  return result
}

function chatToolCalls(message: UnknownRecord): UnknownRecord[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(message.toolCalls) ? message.toolCalls : []
  return calls.map(record)
}

/** 把现有 Conversation Manager 的消息转换为 Responses input items。 */
export function messagesForResponses(messages: readonly ModelMessage[] = []): unknown[] {
  const items: unknown[] = []
  for (const rawMessage of messages) {
    const message = record(rawMessage)
    const protocol = record(message.protocol)
    if (protocol.kind === "responses" && Array.isArray(protocol.outputItems)) {
      items.push(...protocol.outputItems)
      continue
    }
    const role = text(message.role)
    if (role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: text(message.tool_call_id || message.toolCallId),
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      })
      continue
    }
    const calls = chatToolCalls(message)
    const content = responseContent(message.content, role)
    const hasContent = typeof content === "string" ? Boolean(content) : Array.isArray(content) && content.length > 0
    if (hasContent || !calls.length) items.push({ role, content })
    for (const call of calls) {
      const fn = record(call.function)
      items.push({
        type: "function_call",
        call_id: text(call.call_id || call.id),
        name: text(fn.name || call.name),
        arguments: typeof (fn.arguments ?? call.arguments) === "string"
          ? text(fn.arguments ?? call.arguments)
          : JSON.stringify(fn.arguments ?? call.arguments ?? {}),
      })
    }
  }
  return items
}

/**
 * 恢复输入只保留完整的本地 Function Call 对。失败请求留下的孤立 output、
 * 未执行完的 call 或重复 call_id 只属于审计日志，不能再次进入模型上下文。
 */
export function pruneBrokenFunctionCallPairs(items: readonly unknown[] = []): { items: unknown[]; droppedToolItems: number } {
  const values = items.map(record)
  const outputIndexes = new Map<string, number>()
  for (let index = 0; index < values.length; index++) {
    const item = values[index]
    if (item.type !== "function_call_output") continue
    const callId = text(item.call_id).trim()
    if (callId) outputIndexes.set(callId, index)
  }
  const callIndexes = new Map<string, number>()
  for (let index = 0; index < values.length; index++) {
    const item = values[index]
    if (item.type !== "function_call") continue
    const callId = text(item.call_id || item.id).trim()
    const outputIndex = outputIndexes.get(callId)
    if (callId && outputIndex !== undefined && index < outputIndex) callIndexes.set(callId, index)
  }
  let droppedToolItems = 0
  const repaired = items.filter((item, index) => {
    const value = record(item)
    if (value.type === "function_call") {
      const keep = callIndexes.get(text(value.call_id || value.id).trim()) === index
      if (!keep) droppedToolItems++
      return keep
    }
    if (value.type === "function_call_output") {
      const callId = text(value.call_id).trim()
      const keep = outputIndexes.get(callId) === index && callIndexes.has(callId)
      if (!keep) droppedToolItems++
      return keep
    }
    return true
  })
  return { items: repaired, droppedToolItems }
}

function responsesInstructions(messages: readonly ModelMessage[] = []): string {
  return messages
    .filter(message => record(message).role === "system")
    .map(message => contentToText(record(message).content))
    .map(value => value.trim())
    .filter(Boolean)
    .join("\n\n")
}

/** previous_response_id 已经携带旧状态，只发送上一响应之后新增的输入。 */
function incrementalResponsesInput(messages: readonly ModelMessage[] = []): unknown[] {
  let start = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const protocol = record(record(messages[index]).protocol)
    if (protocol.kind === "responses") {
      start = index + 1
      break
    }
  }
  const candidates = start >= 0
    ? messages.slice(start)
    : (() => {
        const lastUser = [...messages].map(message => text(record(message).role)).lastIndexOf("user")
        return lastUser >= 0 ? messages.slice(lastUser) : messages.slice(-1)
      })()
  return messagesForResponses(candidates.filter(message => record(message).role !== "system"))
}

export function responsesSettings(channel: ModelChannel): UnknownRecord {
  return record(record(channel.modelConfig).responses)
}

export function nativeResponsesToolsEnabled(channel: ModelChannel): { webSearch: boolean; toolSearch: boolean; fileSearch: boolean } {
  const settings = responsesSettings(channel)
  const runtime = record(channel.responsesRuntime)
  return {
    webSearch: runtime.webSearchAllowed === true,
    toolSearch: runtime.toolSearchAllowed === true,
    fileSearch: runtime.fileSearchAllowed === true && record(settings.fileSearch).enabled === true,
  }
}

/** 组合 Responses 原生 Built-in Tools 与本地统一 Function Tools。 */
export function toolsForResponses(tools: readonly ToolDefinition[] = [], channel: ModelChannel): UnknownRecord[] {
  const settings = responsesSettings(channel)
  const enabled = nativeResponsesToolsEnabled(channel)
  const localFunctions = tools
    .filter(tool => !(enabled.toolSearch && tool.name === "tool_search"))
    .filter(tool => !(enabled.webSearch && tool.name === "web_search"))
    .map(tool => responsesToolDefinition(tool))
    .map(tool => {
      if (enabled.toolSearch || tool.defer_loading !== true) return tool
      // defer_loading 只有与原生 tool_search 同时提供才合法；工具发现关闭时，
      // 保留函数但改为直接加载，不能把无效组合交给上游。
      const { defer_loading: _deferLoading, ...eager } = tool
      return eager
    })
  const builtins: UnknownRecord[] = []
  if (enabled.webSearch) {
    const webSearch = record(settings.webSearch)
    builtins.push({ ...record(webSearch.params), type: "web_search" })
  }
  if (enabled.fileSearch) {
    const fileSearch = record(settings.fileSearch)
    const vectorStoreIds = stringList(fileSearch.vectorStoreIds)
    if (vectorStoreIds.length) {
      builtins.push({
        ...record(fileSearch.params),
        type: "file_search",
        vector_store_ids: vectorStoreIds,
        ...(Number(fileSearch.maxNumResults) > 0 ? { max_num_results: Math.floor(Math.max(1, Math.min(50, Number(fileSearch.maxNumResults)))) } : {}),
      })
    }
  }
  if (enabled.toolSearch && localFunctions.some(tool => tool.defer_loading === true)) builtins.push({ type: "tool_search" })
  return [...builtins, ...localFunctions]
}

function responsesToolChoice(choice: ModelToolChoice | undefined): unknown {
  if (!choice || choice === "auto") return undefined
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.name }
}

export function buildResponsesRequest(input: ResponsesRequestInput): UnknownRecord {
  const { channel } = input
  const settings = responsesSettings(channel)
  const runtime = record(channel.responsesRuntime)
  const configuredMode = text(runtime.stateMode)
  const stateMode: ResponsesStateMode = configuredMode === "local" || configuredMode === "previous_response_id" ? configuredMode : "auto"
  const previousResponseId = responsesUsesUpstreamState(stateMode) ? text(runtime.previousResponseId).trim() : ""
  const store = responsesUsesUpstreamState(stateMode) ? true : settings.store === true
  const nativeTools = nativeResponsesToolsEnabled(channel)
  const configuredInclude = stringList(settings.include)
  const include = [...new Set([
    ...configuredInclude,
    ...(!store || stateMode === "auto" ? ["reasoning.encrypted_content"] : []),
    ...(nativeTools.webSearch ? ["web_search_call.action.sources"] : []),
    ...(nativeTools.fileSearch ? ["file_search_call.results"] : []),
  ])]
  const body: UnknownRecord = {
    ...record(channel.params),
    model: channel.model || "gpt-5-mini",
    input: previousResponseId ? incrementalResponsesInput(input.messages) : messagesForResponses(input.messages),
    store,
  }
  delete body.previous_response_id
  delete body.conversation
  if (previousResponseId) {
    body.previous_response_id = previousResponseId
    const instructions = responsesInstructions(input.messages)
    if (instructions) body.instructions = instructions
  }
  const choice = responsesToolChoice(input.toolChoice)
  const forcedFunctionName = record(choice).type === "function" ? text(record(choice).name).trim() : ""
  // 指定函数已经是本轮明确目标，必须直接加载；继续携带 defer_loading 却不带
  // tool_search 会被 Responses 拒绝，同时保留 tool_search 也只会产生多余发现步骤。
  const tools = toolsForResponses(input.tools || [], channel)
    .filter(tool => !(forcedFunctionName && tool.type === "tool_search"))
    .map(tool => {
      if (!forcedFunctionName || tool.type !== "function" || text(tool.name) !== forcedFunctionName) return tool
      const { defer_loading: _deferLoading, ...eager } = tool
      return eager
    })
  if (tools.length) body.tools = tools
  if (choice !== undefined) body.tool_choice = choice
  const maxTokens = Math.max(0, Number(input.maxTokens) || 0)
  if (maxTokens) body.max_output_tokens = maxTokens
  if (include.length) body.include = include
  if (typeof settings.parallelToolCalls === "boolean") body.parallel_tool_calls = settings.parallelToolCalls
  if (Number(settings.maxBuiltInToolCalls) > 0) body.max_tool_calls = Math.floor(Math.max(1, Math.min(100, Number(settings.maxBuiltInToolCalls))))
  delete body.messages
  delete body.max_tokens
  delete body.max_completion_tokens
  return applyReasoningPayload(body, channel)
}

/** 构造断链后的无状态请求；不会修改普通请求或重新执行任何本地工具。 */
export function buildResponsesRecoveryRequest(input: ResponsesRequestInput): ResponsesRecoveryRequest {
  const replayMessages = input.replayMessages?.length ? input.replayMessages : input.messages
  const runtime = record(input.channel.responsesRuntime)
  const body = buildResponsesRequest({
    ...input,
    messages: replayMessages,
    channel: {
      ...input.channel,
      responsesRuntime: { ...runtime, stateMode: "auto", previousResponseId: "" },
    },
  })
  const repaired = pruneBrokenFunctionCallPairs(Array.isArray(body.input) ? body.input : [])
  body.input = repaired.items
  delete body.previous_response_id
  return {
    body,
    replayedMessages: replayMessages.length,
    droppedToolItems: repaired.droppedToolItems,
  }
}
