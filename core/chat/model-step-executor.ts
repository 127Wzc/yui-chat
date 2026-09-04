import { adapterRegistry } from "../../models/adapters/registry.js"
import { filterToolsForModel, hostedToolIds, modelToolAllowed, modelToolRoute } from "../../models/configuration/tool-policy.js"
import { responsesStateKey, responsesStateMode, responsesUsesUpstreamState } from "../../models/configuration/responses-state.js"
import type { ModelChannel, ModelHostedToolCall, ModelMessage, ModelSearchSource } from "../../models/protocol/types.js"
import { explainToolPolicy } from "../../tools/access/policy.js"
import type { ToolDefinition } from "../../tools/support/tool-contract.js"
import { getToolCommon, resolveToolExecutionPolicy } from "../../tools/support/contract.js"
import { toolRegistry, type RegistryExecutionContext } from "../../tools/support/registry.js"
import { createExecutionRuntime } from "../../tools/support/execution-runtime.js"
import { buildPersonaMessagesWithContext, buildUserMessage, type PersonaContextSection } from "../persona/persona-chain.js"
import { findUnsupportedMediaCQCodes } from "../message/cq-code.js"
import type { UnknownRecord } from "../message/types.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { modelLogStore } from "../observability/model-log.js"
import { conversationLog } from "./conversation-log.js"
import { createAgentTurnState } from "./agent-turn-state.js"
import { enforcePromptBudgetDetailed, estimateTokens, messageTokens, selectPromptTools } from "./token-budget.js"
import { executeToolRound } from "./tool-round-executor.js"
import { normalizeResponseText } from "./response-pipeline.js"
import {
  addUsage,
  buildAgentLoopContinuationMessages,
  buildAutomaticDeliveryContinuationMessages,
  buildMediaDeliveryCorrectionMessages,
  buildMediaSelectionCorrectionMessages,
  buildSearchDeliveryMessages,
  buildToolLimitFinalizationMessages,
  emptyUsage,
  hasSuccessfulMediaDelivery,
  modelRouteMetadata,
  priorStepMessage,
  scopeFor,
} from "./chat-support.js"
import { errorSummary } from "../shared/error-details.js"

interface ModelStepOptions {
  e?: unknown
  prompt?: unknown
  config?: unknown
  history?: unknown[]
  protocolState?: unknown
  step?: unknown
  channel?: unknown
  prior?: unknown[]
  media?: unknown
  source?: unknown
  purpose?: unknown
  extraSystemPrompt?: unknown
  agentContext?: unknown
  disableTools?: unknown
  trace?: unknown
  parentToolId?: unknown
  availableChannels?: unknown[]
  channelAttempt?: unknown
  selectionStrategy?: unknown
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stepConfig(config: UnknownRecord, step: UnknownRecord): UnknownRecord {
  return record(record(config.modelTasks)[text(step.task)])
}

function modelChannel(value: unknown): ModelChannel {
  return record(value) as unknown as ModelChannel
}

function modelMessages(value: UnknownRecord[]): ModelMessage[] {
  return value as unknown as ModelMessage[]
}

function toolDefinitions(value: unknown[]): ToolDefinition[] {
  return value as ToolDefinition[]
}

const searchToolNamePattern = /(?:^|[_:./-])(?:search|find|lookup|query|retrieve|recommend)(?:[_:./-]|$)/i
const searchActionPattern = /^(?:search|find|lookup|query|recommend|搜索|检索|查找|查询|推荐)$/i
const searchIntentPattern = /(?:搜索|搜一下|搜一搜|搜个|搜些|检索|查找|查一查|查询|帮我查|找一下|找一个|找个|找些|找几|找张|找段|找部|推荐|search|find|look\s*up|lookup|retrieve|recommend)/i
const currentLookupIntentPattern = /(?:看看|看下|看一下).{0,16}(?:今天|今日|最新|实时|当前|现在|价格|行情|新闻|天气|汇率)/i
const searchDescriptionPattern = /(?:搜索|检索|查找|查询|推荐|\bsearch(?:es|ing)?\b|\bfind\b|\blookup\b|\bretriev(?:e|al)\b|\brecommend(?:s|ation)?\b)/i
const mediaSendNegationPattern = /(?:不要|别|无需|不用|暂不|先不).{0,8}(?:发|发送|send)/i
const imageSearchActionPattern = /(?:搜索|搜(?:一下|一搜|个|些|几|张|两张)?|查找|找(?:一下|个|些|几|张|两张)?|推荐|search|find|look\s*up)/i
const imageSearchTargetPattern = /(?:图片|图像|照片|表情包|表情图|梗图|壁纸|头像|贴纸|动图|gif|images?|pictures?|photos?|memes?|stickers?)/i

function isImageMediaSearchRequest(prompt: unknown): boolean {
  const value = text(prompt)
  return imageSearchActionPattern.test(value) && imageSearchTargetPattern.test(value)
}

function toolAutoDelivery(name: unknown): UnknownRecord {
  const tool = toolRegistry.get(text(name).trim())
  return record(getToolCommon(tool).autoDelivery)
}

function usesAutomaticMessageSend(name: unknown): boolean {
  return text(toolAutoDelivery(name).via) === "message_send"
}

function normalizedToolName(value: unknown): string {
  return text(value).replace(/([a-z0-9])([A-Z])/g, "$1_$2")
}

function isSearchToolTrace(trace: UnknownRecord, prompt: string): boolean {
  const name = text(trace.name).trim()
  if (!name || name === "tool_search") return false
  if (usesAutomaticMessageSend(name) && text(record(trace.arguments).action).toLowerCase() === "search") return false
  const tool = toolRegistry.get(name)
  if (!tool) return searchToolNamePattern.test(normalizedToolName(name))
  const common = getToolCommon(tool)
  const args = record(trace.arguments)
  const toolRecord = record(tool)
  const tags = Array.isArray(common.tags) ? common.tags.map(text) : []
  if (tags.some(tag => ["search", "retrieval", "web-search"].includes(tag.toLowerCase()))) return true
  if (["search", "retrieval", "web-search"].includes(text(common.category).toLowerCase())) return true
  if (searchDescriptionPattern.test(`${text(common.description)} ${text(common.descriptionZh)}`)) return true
  if ([name, toolRecord.originalName].some(candidate => searchToolNamePattern.test(normalizedToolName(candidate))) || searchActionPattern.test(text(args.action).trim())) return true
  const effect = resolveToolExecutionPolicy(tool, args).execution.effect
  return searchIntentPattern.test(prompt)
    && common.category !== "discovery"
    && (effect === "read" || (common.source === "mcp" && effect === "unknown"))
}

function applyRuntimeToolIntent(toolCalls: UnknownRecord[] = [], prompt: string): UnknownRecord[] {
  return toolCalls.map(call => {
    if (!usesAutomaticMessageSend(call.name) || text(record(call.arguments).action).trim()) return call
    return {
      ...call,
      arguments: {
        ...record(call.arguments),
        action: mediaSendNegationPattern.test(prompt) ? "search" : "send",
      },
    }
  })
}

function plannedMessageParts(traces: UnknownRecord[] = []): UnknownRecord[] {
  return traces.flatMap(trace => {
    if (trace.status !== "ok" || !hasMessageSendPlan(trace)) return []
    const plan = record(record(trace.metadata).messageSendPlan)
    return Array.isArray(plan.parts) ? plan.parts.map(record).filter(part => Object.keys(part).length) : []
  })
}

function plannedMessageAppendParts(traces: UnknownRecord[] = []): UnknownRecord[] {
  return traces.flatMap(trace => {
    if (trace.status !== "ok") return []
    const plan = record(record(trace.metadata).messageSendAppendPlan)
    return Array.isArray(plan.parts) ? plan.parts.map(record).filter(part => Object.keys(part).length) : []
  })
}

function appendPlannedMessageParts(toolCalls: UnknownRecord[], parts: UnknownRecord[]): UnknownRecord[] {
  if (!parts.length) return toolCalls
  return toolCalls.map(call => {
    if (text(call.name) !== "message_send") return call
    const args = record(call.arguments)
    const current = Array.isArray(args.parts) ? args.parts.map(record) : []
    // 模型已经按工具说明生成 forward 时尊重它的选择，避免来源重复。
    if (current.some(part => text(part.type) === "forward")) return call
    return { ...call, arguments: { ...args, parts: [...current, ...parts] } }
  })
}

function mergePlannedParts(current: UnknownRecord[], incoming: UnknownRecord[]): UnknownRecord[] {
  const seen = new Set<string>()
  return [...current, ...incoming].filter(item => {
    let key = ""
    try { key = JSON.stringify(item) } catch { key = String(item) }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hasMessageSendPlan(trace: UnknownRecord): boolean {
  return usesAutomaticMessageSend(trace.name)
    && Array.isArray(record(record(trace.metadata).messageSendPlan).parts)
}

function shouldContinueAfterAutomaticDelivery(traces: UnknownRecord[] = []): boolean {
  return traces.some(trace => trace.status === "ok"
    && hasMessageSendPlan(trace)
    && toolAutoDelivery(trace.name).continueConversation === true)
}

interface ContextHint {
  source: string
  label: string
}

const contextSourceLabels: Record<string, string> = {
  "system-context": "系统上下文",
  "step-instruction": "步骤指令",
  workflow: "前序步骤",
  history: "会话历史",
  current: "当前提问",
  "model-decision": "模型工具决策",
  "tool-result": "工具返回结果",
  "runtime-instruction": "运行时收束指令",
  other: "其他上下文",
}

function messageContentText(message: unknown): string {
  const value = record(message).content
  if (typeof value === "string") return value
  try { return JSON.stringify(value ?? "") || "" } catch { return String(value ?? "") }
}

function messageChars(message: unknown): number {
  return messageContentText(message).length
}

function messageToolCallIds(message: unknown): string[] {
  const source = record(message)
  const calls = Array.isArray(source.tool_calls) ? source.tool_calls : Array.isArray(source.toolCalls) ? source.toolCalls : []
  const ids = calls.map(call => text(record(call).id)).filter(Boolean)
  const toolCallId = text(source.tool_call_id || source.toolCallId)
  return [...new Set(toolCallId ? [...ids, toolCallId] : ids)]
}

function inferredContextHint(message: unknown, index: number, messages: readonly UnknownRecord[]): ContextHint {
  const source = record(message)
  const role = text(source.role)
  if (role === "system") {
    const systemIndex = messages.slice(0, index).filter(item => text(record(item).role) === "system").length
    return systemIndex === 0
      ? { source: "system-context", label: contextSourceLabels["system-context"] }
      : { source: "step-instruction", label: contextSourceLabels["step-instruction"] }
  }
  if (role === "tool") return { source: "tool-result", label: contextSourceLabels["tool-result"] }
  if (role === "assistant" && messageToolCallIds(message).length) return { source: "model-decision", label: contextSourceLabels["model-decision"] }
  const content = messageContentText(message)
  if (role === "user" && /^【(?:工具收束|工具循环继续|媒体发送纠正|媒体选择纠正|搜索结果统一发送)/.test(content)) {
    return { source: "runtime-instruction", label: contextSourceLabels["runtime-instruction"] }
  }
  if (role === "user" && index === [...messages].map(item => text(record(item).role)).lastIndexOf("user")) {
    return { source: "current", label: contextSourceLabels.current }
  }
  if (role === "user" || role === "assistant") return { source: "history", label: contextSourceLabels.history }
  return { source: "other", label: contextSourceLabels.other }
}

function contextMetadata(messages: readonly UnknownRecord[], phase: string, hints: WeakMap<object, ContextHint>, personaSections: readonly PersonaContextSection[] = [], includeSectionContent = false, includeItems = true): UnknownRecord {
  const items = messages.map((message, index) => {
    const hint = message && typeof message === "object" ? hints.get(message as object) : undefined
    const resolved = hint || inferredContextHint(message, index, messages)
    return {
      index,
      role: text(record(message).role || "unknown"),
      source: resolved.source,
      label: resolved.label,
      chars: messageChars(message),
      tokenEstimate: messageTokens(message),
      toolCallIds: messageToolCallIds(message),
    }
  })
  const grouped = new Map<string, UnknownRecord>()
  for (const item of items) {
    const key = text(item.source)
    const current = grouped.get(key) || { source: key, label: text(item.label), messageIndexes: [], count: 0, chars: 0, tokenEstimate: 0 }
    ;(current.messageIndexes as number[]).push(Number(item.index))
    current.count = Number(current.count || 0) + 1
    current.chars = Number(current.chars || 0) + Number(item.chars || 0)
    current.tokenEstimate = Number(current.tokenEstimate || 0) + Number(item.tokenEstimate || 0)
    grouped.set(key, current)
  }
  const systemIndex = items.find(item => item.source === "system-context")?.index
  const sections: UnknownRecord[] = []
  for (const section of personaSections) {
    sections.push({
      source: section.source,
      label: section.label,
      messageIndexes: systemIndex === undefined ? [] : [systemIndex],
      count: 1,
      chars: section.content.length,
      tokenEstimate: estimateTokens(section.content),
      ...(includeSectionContent ? { content: section.content } : {}),
    })
  }
  for (const item of grouped.values()) {
    if (item.source === "system-context" && personaSections.length) continue
    sections.push(item)
  }
  sections.sort((left, right) => Number((left.messageIndexes as number[])[0] ?? 0) - Number((right.messageIndexes as number[])[0] ?? 0))
  return {
    phase,
    total: {
      messageCount: messages.length,
      chars: items.reduce((sum, item) => sum + Number(item.chars || 0), 0),
      tokenEstimate: items.reduce((sum, item) => sum + Number(item.tokenEstimate || 0), 0),
    },
    ...(includeItems ? { items } : {}),
    sections,
  }
}

function registryContext(value: UnknownRecord): RegistryExecutionContext {
  return value as RegistryExecutionContext
}

type HostedToolCapability = "webSearch" | "fileSearch" | "toolSearch"

const hostedPolicyTools: Record<HostedToolCapability, UnknownRecord> = {
  webSearch: {
    name: "web_search",
    source: "builtin",
    category: "network",
    risk: "external",
    policy: { externalNetwork: true },
  },
  fileSearch: {
    name: "file_search",
    source: "builtin",
    category: "memory",
    risk: "low",
    policy: {},
  },
  toolSearch: {
    name: "tool_search",
    source: "builtin",
    category: "discovery",
    risk: "low",
    policy: {},
  },
}

function hostedToolAllowed(capability: HostedToolCapability, root: UnknownRecord, modelConfig: UnknownRecord, context: UnknownRecord): boolean {
  const openai = record(record(record(root.tools).hosted).openai)
  if (record(root.tools).enabled !== true || openai.enabled === false || record(openai[capability]).enabled === false) return false
  if (!modelToolAllowed(modelConfig, hostedToolIds[capability])) return false
  // The capability switch in tools.enabledTools is the hard upper bound for both
  // local and provider-owned implementations. A model route can only narrow it.
  return explainToolPolicy(hostedPolicyTools[capability], registryContext(context)).allowed
}

function localToolAllowed(name: string, modelConfig: UnknownRecord, context: UnknownRecord): boolean {
  const tool = toolRegistry.get(name)
  return Boolean(tool)
    && modelToolAllowed(modelConfig, name)
    && explainToolPolicy(tool, registryContext(context)).allowed
}

function hostedToolName(type: unknown): string {
  const value = text(type).replace(/_(?:call|output)$/, "")
  return `openai:${value || "hosted_tool"}`
}

function hostedToolCategory(type: unknown): string {
  if (text(type).startsWith("web_search")) return "network"
  if (text(type).startsWith("file_search")) return "memory"
  return "discovery"
}

function hostedToolStatus(value: unknown): string {
  const status = text(value).toLowerCase()
  if (["completed", "success", "succeeded"].includes(status)) return "ok"
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed"
  return status || "accepted"
}

function hostedToolTrace(call: ModelHostedToolCall, round: number): { trace: UnknownRecord; logResult: string } {
  const argumentsValue = {
    ...(call.query ? { query: call.query } : {}),
    ...(call.queries?.length ? { queries: call.queries } : {}),
  }
  const result = {
    ...(call.loadedTools?.length ? { loadedTools: call.loadedTools } : {}),
    ...(Number.isFinite(Number(call.resultCount)) ? { resultCount: Number(call.resultCount) } : {}),
    ...(call.sources?.length ? { sources: call.sources } : {}),
  }
  let logResult = "{}"
  try { logResult = JSON.stringify(call.raw ?? result) || "{}" } catch { logResult = JSON.stringify(result) }
  return {
    logResult,
    trace: {
      round,
      id: call.id,
      name: hostedToolName(call.type),
      source: "openai-hosted",
      category: hostedToolCategory(call.type),
      arguments: argumentsValue,
      status: hostedToolStatus(call.status),
      error: hostedToolStatus(call.status) === "failed" ? `OpenAI 托管工具状态：${call.status}` : "",
      durationMs: 0,
      resultPreview: logResult.slice(0, 300),
      resultChars: logResult.length,
      delivery: "remote",
      requiresFinalReply: true,
      repeatPolicy: "provider_managed",
      retryPolicy: "provider_managed",
      dispatched: true,
      deduplicated: false,
      effect: "read",
      decision: "provider_managed",
      guardCode: "OPENAI_HOSTED_TOOL",
      metadata: {
        hosted: true,
        remote: true,
        provider: "openai",
        protocol: "responses",
        eventType: call.type,
        execution: call.execution || "",
        loadedTools: call.loadedTools || [],
        resultCount: call.resultCount || 0,
        sources: call.sources || [],
      },
    },
  }
}

/** 执行一次模型步骤及其工具轮次；Chat Service 只负责决定何时调用它。 */
export async function runModelStepWithChannelInternal(options: ModelStepOptions = {}): Promise<UnknownRecord> {
  const root = record(options.config)
  const chat = record(root.chat)
  const toolsConfig = record(root.tools)
  const mediaRecognition = record(root.mediaRecognition)
  const step = record(options.step)
  const channel = record(options.channel)
  const modelConfig = record(channel.modelConfig)
  const configuredResponsesStateMode = responsesStateMode(modelConfig)
  const responseStateKey = responsesStateKey(channel)
  const previousResponseState = record(record(record(options.protocolState).responses)[responseStateKey])
  const previousResponseId = responsesUsesUpstreamState(configuredResponsesStateMode) ? text(previousResponseState.previousResponseId).trim() : ""
  const source = text(options.source)
  const purpose = text(options.purpose || (source === "subagent" ? "subagent" : "chat"))
  const agentContext = record(options.agentContext)
  const hasAgentContext = Boolean(options.agentContext)
  const prior = Array.isArray(options.prior) ? options.prior : []
  const history = Array.isArray(options.history) ? options.history.map(record) : []
  const prompt = options.prompt
  const adapter = adapterRegistry.get(text(channel.type))
  const stepInstruction = step.mode === "draft"
    ? "请先给出可用于最终回答的草稿，不要声称这是最终结论。"
    : step.mode === "review"
      ? "请审阅前一步草稿，指出遗漏、错误和是否需要检索指令。"
      : "请给出最终可直接发送给用户的回答。"
  const priorMessages = prior
    .map(item => priorStepMessage(item))
    .filter((item): item is UnknownRecord => Boolean(item))
  const personaBuild = await buildPersonaMessagesWithContext(options.e, prompt, root, { media: options.media, source, extraSystemPrompt: options.extraSystemPrompt })
  const stepMessage: UnknownRecord = { role: "system", content: stepInstruction }
  const currentMessage = buildUserMessage(options.e, prompt, root, {
    vision: adapter.supportsVision && record(channel.modelConfig).visual !== false && mediaRecognition.preferNativeVision !== false,
    media: options.media,
  })
  const contextHints = new WeakMap<object, ContextHint>()
  const markContext = (items: readonly unknown[], hint: ContextHint): void => {
    for (const item of items) if (item && typeof item === "object" && !Array.isArray(item)) contextHints.set(item as object, hint)
  }
  markContext(personaBuild.messages, { source: "system-context", label: contextSourceLabels["system-context"] })
  markContext([stepMessage], { source: "step-instruction", label: contextSourceLabels["step-instruction"] })
  markContext(priorMessages, { source: "workflow", label: contextSourceLabels.workflow })
  markContext(history, { source: "history", label: contextSourceLabels.history })
  markContext([currentMessage], { source: "current", label: contextSourceLabels.current })
  const commonMessages: UnknownRecord[] = [
    ...personaBuild.messages,
    stepMessage,
    ...priorMessages,
  ]
  let messages: UnknownRecord[] = [
    ...commonMessages,
    ...(previousResponseId ? [] : history),
    currentMessage,
  ]
  let recoveryMessages: UnknownRecord[] = configuredResponsesStateMode === "auto" && previousResponseId
    ? [...commonMessages, ...history, currentMessage]
    : messages

  const isInteractiveConversation = !hasAgentContext && source !== "subagent"
  const maxToolRounds = hasAgentContext
    ? Math.max(0, number(agentContext.maxToolRounds))
    : Math.max(0, number(chat.maxToolRounds))
  const maxToolCallsPerRound = hasAgentContext
    ? Math.max(1, Math.min(number(agentContext.maxToolCallsPerRound, 1), 8))
    : 0
  const trace = options.trace
  const executionRuntime = createExecutionRuntime({
    runId: text(record(trace).id),
    userTurnId: text(record(options.e).message_id || record(options.e).messageId),
    prompt,
    config: root,
    event: record(options.e),
    scope: scopeFor(options.e),
    maxTurns: maxToolRounds,
    maxToolCalls: hasAgentContext
      ? Math.max(1, maxToolRounds * maxToolCallsPerRound)
      : record(chat.execution).maxToolCalls,
    maxSideEffectCalls: record(chat.execution).maxSideEffectCalls,
  })
  const agentTurn = createAgentTurnState()
  const beginFinalization = (reason: unknown): void => {
    executionRuntime.enterFinalization(reason)
    agentTurn.beginFinalization(reason)
  }
  const toolContext: UnknownRecord & { dynamicTools?: Set<string> } = {
    e: options.e,
    prompt,
    channel,
    media: options.media,
    config: root,
    agent: hasAgentContext ? agentContext : null,
    executionRuntime,
    observability: {
      trace,
      source,
      purpose,
      toolCallId: text(options.parentToolId),
    },
    delivery: {
      // 当前会话文字由输出层统一发送，避免即时发送工具与最终回答重复。
      allowCurrentChat: !isInteractiveConversation,
    },
  }
  const dynamicTools = new Set<string>()
  toolContext.dynamicTools = dynamicTools
  const toolUseEnabled = options.disableTools !== true
    && toolsConfig.enabled === true
    && adapter.supportsTools
    && modelConfig.toolUse !== false
  let enabledTools = [] as Awaited<ReturnType<typeof toolRegistry.getAllowedTools>>
  const responsesConfig = record(modelConfig.responses)
  const webSearchRoute = modelToolRoute(modelConfig, "web_search")
  const toolSearchRoute = modelToolRoute(modelConfig, "tool_search")
  const webSearchSource = webSearchRoute.source
  const toolSearchSource = toolSearchRoute.source
  const webSearchStrategy = webSearchRoute.strategy
    || (["preferred", "parallel"].includes(text(record(record(toolsConfig.builtin).webSearch).strategy))
      ? text(record(record(toolsConfig.builtin).webSearch).strategy) as "preferred" | "parallel"
      : "fallback")
  // 图片、表情包等明确媒体搜索交给 image_media：它能按数量选择并进入受管
  // 媒体投递链。此时不把通用托管网页搜索同时交给模型，避免一次响应内为同一
  // 媒体意图反复发起多个 web_search_call。
  const preferLocalImageMedia = toolUseEnabled
    && adapter.protocol === "responses"
    && adapter.supportsNativeToolSearch
    && isImageMediaSearchRequest(prompt)
    && localToolAllowed("image_media", modelConfig, toolContext)
  const hostedWebSearchAvailable = toolUseEnabled
    && adapter.supportsNativeToolSearch
    && !preferLocalImageMedia
    && (webSearchSource === "auto" || webSearchSource === "hosted")
    && hostedToolAllowed("webSearch", root, modelConfig, toolContext)
  const configuredLocalWebSearchSources = record(record(toolsConfig.builtin).webSearch).enabledSources
  const localWebSearchChannelsAvailable = !Array.isArray(configuredLocalWebSearchSources)
    || configuredLocalWebSearchSources.length > 0
  const aggregatedHostedWebSearch = webSearchStrategy !== "preferred"
    && webSearchSource === "auto"
    && hostedWebSearchAvailable
    && localWebSearchChannelsAvailable
    && localToolAllowed("web_search", modelConfig, toolContext)
  const nativeWebSearchEnabled = hostedWebSearchAvailable && !aggregatedHostedWebSearch
  const nativeToolSearchEnabled = toolUseEnabled
    && adapter.supportsNativeToolSearch
    && (toolSearchSource === "auto" || toolSearchSource === "hosted")
    && hostedToolAllowed("toolSearch", root, modelConfig, toolContext)
  const forceAggregatedWebSearch = aggregatedHostedWebSearch
    && (searchIntentPattern.test(text(prompt)) || currentLookupIntentPattern.test(text(prompt)))
    && !isImageMediaSearchRequest(prompt)
  // 已经由运行时明确选择具体能力时，不再让托管 tool_search 重复发现同一个
  // 函数。这样图片/网页搜索请求只保留真正执行搜索的工具链。
  const nativeToolSearchEnabledForRequest = nativeToolSearchEnabled
    && !preferLocalImageMedia
    && !forceAggregatedWebSearch
  const nativeFileSearchEnabled = toolUseEnabled
    && adapter.supportsNativeToolSearch
    && record(responsesConfig.fileSearch).enabled === true
    && hostedToolAllowed("fileSearch", root, modelConfig, toolContext)
  const localWebSearchEnabled = webSearchSource === "local" || aggregatedHostedWebSearch || (webSearchSource === "auto" && !nativeWebSearchEnabled)
  const localToolSearchAvailable = record(record(toolsConfig.builtin).toolSearch).localEnabled !== false
  const localToolSearchEnabled = localToolSearchAvailable && (toolSearchSource === "local" || (toolSearchSource === "auto" && !nativeToolSearchEnabled))
  const filterModelLocalTools = <T extends { name?: unknown }>(tools: readonly T[]): T[] => filterToolsForModel(tools, modelConfig).filter(tool => {
    if (tool.name === "web_search") return localWebSearchEnabled
    if (tool.name === "tool_search") return localToolSearchEnabled
    return true
  })
  toolContext.toolDiscovery = {
    search: async (query: unknown, limit: unknown) => filterModelLocalTools(
      await toolRegistry.searchAllowedTools(text(query), registryContext(toolContext), number(limit, 8)),
    ),
  }
  toolContext.searchRouting = { webSearch: { strategy: webSearchStrategy } }
  if (toolUseEnabled) {
    if (hasAgentContext) {
      enabledTools = toolRegistry.getToolsByNames(list(agentContext.allowedTools).map(text), registryContext(toolContext))
    } else {
      enabledTools = await toolRegistry.getAllowedTools({
        ...registryContext(toolContext),
        excludeDeliveryModes: isInteractiveConversation ? ["current-chat"] : [],
      })
      if (record(root.subAgent).enabled !== true) enabledTools = enabledTools.filter(tool => tool.name !== "dispatch_subagent")
    }
    enabledTools = filterModelLocalTools(enabledTools)
  }
  const allowedToolCandidates = enabledTools
  if (adapter.supportsNativeToolSearch) {
    channel.responsesRuntime = {
      webSearchAllowed: nativeWebSearchEnabled,
      fileSearchAllowed: nativeFileSearchEnabled,
      toolSearchAllowed: nativeToolSearchEnabledForRequest,
      stateMode: configuredResponsesStateMode,
      previousResponseId,
    }
  }
  const taskConfig = stepConfig(root, step)
  const maxTokens = Math.max(1, number(taskConfig.maxTokens, 1024))
  // 只有整个会话超出窗口才会压缩；压缩一旦发生就必须在链路里留下痕迹，
  // 否则"模型好像忘了前面说过什么"这类问题无从排查。
  // 预算目标优先用当前渠道模型声明的上下文窗口，未声明时回落全局聊天预算。
  const budgeted = (input: UnknownRecord[], phase: string): UnknownRecord[] => {
    const outcome = enforcePromptBudgetDetailed(input, root, { channel, maxTokens })
    if (outcome.compressed) {
      conversationLog.promptCompressed(root, {
        limit: outcome.limit,
        before: outcome.before,
        after: outcome.after,
        toolPayloadsCompressed: outcome.toolPayloadsCompressed,
        unitsDropped: outcome.unitsDropped,
        messagesDropped: outcome.messagesDropped,
        phase,
      })
    }
    return outcome.messages
  }
  const hasSeparateRecoveryContext = recoveryMessages !== messages
  messages = budgeted(messages, "initial")
  recoveryMessages = hasSeparateRecoveryContext
    ? budgeted(recoveryMessages, "responses-recovery-checkpoint")
    : messages
  if (nativeToolSearchEnabledForRequest) {
    enabledTools = enabledTools.filter(tool => tool.name !== "tool_search" && (!nativeWebSearchEnabled || tool.name !== "web_search"))
  } else {
    enabledTools = selectPromptTools(enabledTools, text(prompt), record(toolsConfig.promptSelection))
  }
  if (toolUseEnabled && localToolSearchEnabled && modelToolAllowed(modelConfig, "tool_search") && !enabledTools.some(tool => tool.name === "tool_search")) {
    const discoveryTool = toolRegistry.get("tool_search")
    if (discoveryTool) enabledTools = [discoveryTool, ...enabledTools].slice(0, Math.max(1, number(record(toolsConfig.promptSelection).maxTools, 12)))
  }
  // message_send 每轮固定带着：任何工具都可能返回一个 url 或内联资源令牌，
  // 模型必须随时能把它发出去。工具选择器按提示词相关性打分，很容易在搜索
  // 类请求里把发送工具挤掉，导致模型拿到了资源却无工具可用。
  const pinnedToolNames = new Set([
    "message_send",
    ...(preferLocalImageMedia ? ["image_media"] : []),
    ...(forceAggregatedWebSearch ? ["web_search"] : []),
  ])
  const allowedToolCandidateMap = new Map(allowedToolCandidates.map(tool => [tool.name, tool]))
  const currentTools = (): typeof enabledTools => {
    const loaded = dynamicTools.size
      ? [...dynamicTools].flatMap(name => allowedToolCandidateMap.get(name) || [])
      : []
    const pinned = allowedToolCandidates.filter(tool => pinnedToolNames.has(tool.name))
    const byName = new Map([...enabledTools, ...loaded, ...pinned].map(tool => [tool.name, tool]))
    return filterModelLocalTools([...byName.values()])
  }
  const mediaCorrectionTools = (): typeof enabledTools => currentTools()
  const initialTools = currentTools()
  const initialToolChoice = preferLocalImageMedia && initialTools.some(tool => tool.name === "image_media")
    ? { type: "function" as const, name: "image_media" }
    : forceAggregatedWebSearch && initialTools.some(tool => tool.name === "web_search")
      ? { type: "function" as const, name: "web_search" }
    : undefined
  const routeMetadataFor = (phase: string, round: number): UnknownRecord => modelRouteMetadata({
    taskName: step.task,
    strategy: options.selectionStrategy || taskConfig.selectionStrategy,
    availableChannels: options.availableChannels,
    channel,
    attempt: options.channelAttempt,
    round,
    phase,
  })
  const modelCallMetadata = (input: readonly UnknownRecord[], phase: string, round: number): UnknownRecord => {
    const route = routeMetadataFor(phase, round)
    return {
      metadata: {
        route,
        context: contextMetadata(input, phase, contextHints, [], false, false),
        responsesState: { mode: configuredResponsesStateMode, linked: Boolean(text(record(channel.responsesRuntime).previousResponseId)) },
      },
      snapshotMetadata: {
        route,
        context: contextMetadata(input, phase, contextHints, personaBuild.sections, true),
        responsesState: { mode: configuredResponsesStateMode, linked: Boolean(text(record(channel.responsesRuntime).previousResponseId)) },
      },
    }
  }
  conversationLog.modelRequest(root, {
    channel: channel.id,
    adapter: adapter.id,
    messages: messages.length,
    tools: initialTools.length,
    maxTokens,
    timeoutMs: channel.timeoutMs,
    stream: channel.stream,
  })
  let response = await adapterRegistry.sendMessage({
    channel: modelChannel(channel),
    messages: modelMessages(messages),
    ...(configuredResponsesStateMode === "auto" ? { replayMessages: modelMessages(recoveryMessages) } : {}),
    tools: toolDefinitions(initialTools),
    toolChoice: initialToolChoice,
    event: options.e,
    maxTokens,
    signal: agentContext.signal instanceof AbortSignal ? agentContext.signal : undefined,
    source,
    purpose,
    taskName: text(step.task),
    trace,
    parentToolId: text(record(toolContext.observability).toolCallId),
    ...modelCallMetadata(messages, "initial", 0),
  })
  let toolRounds = 0
  const toolsUsed: string[] = []
  const toolChain: UnknownRecord[] = []
  const usage = emptyUsage()
  const modelCalls: UnknownRecord[] = []
  const hostedSearchSources = new Map<string, ModelSearchSource>()
  let toolLimitReached = false
  let toolFinalizationAttempted = false
  let toolFinalizationError = ""
  let singleAsyncToolCompleted = false
  let mediaCorrectionAttempted = false
  let mediaCorrectionStatus = "not-needed"
  let mediaDirectOutputDetected = false
  let mediaResourceSeen = false
  let toolFinalizationRequired = false
  let searchDeliveryRequired = false
  let searchDeliveryAttempted = false
  let searchDeliveryStatus = "not-needed"
  let searchDeliveryExtraRoundsUsed = 0
  let pendingMessageAppendParts: UnknownRecord[] = []
  const recordModelCall = (current: typeof response, options: { observeTurn?: boolean; updateState?: boolean; logTrace?: UnknownRecord; modelCallId?: string; parentToolId?: string } = {}): void => {
    if (options.observeTurn !== false) agentTurn.observeModel(current.stopReason)
    addUsage(usage, current.usage)
    const modelCallIndex = modelCalls.length + 1
    modelCalls.push({
      index: modelCallIndex,
      usage: current.usage || emptyUsage(),
      toolCalls: current.toolCalls?.length || 0,
      hostedToolCalls: current.hostedToolCalls?.length || 0,
      stopReason: current.stopReason,
      upstreamStateReset: current.upstreamStateReset === true,
      ...(current.responsesStateRecovery ? { responsesStateRecovery: current.responsesStateRecovery } : {}),
    })
    if (options.updateState !== false && responsesUsesUpstreamState(configuredResponsesStateMode)) {
      channel.responsesRuntime = {
        ...record(channel.responsesRuntime),
        previousResponseId: text(current.upstreamResponseId).trim(),
      }
    }
    for (const source of current.hostedSearchSources || []) {
      if (source.url && !hostedSearchSources.has(source.url)) hostedSearchSources.set(source.url, source)
    }
    const hostedCalls = (current.hostedToolCalls || []).filter(call => /_call$/.test(call.type))
    // 托管工具与本地 Function Call 出现在同一个 Responses 输出时，本地工具
    // 执行结果仍必须回到模型生成最终说明，不能被 message_send 的静默语义截断。
    if (hostedCalls.length && current.toolCalls?.length && !normalizeResponseText(current.text)) {
      agentTurn.requestFinalReply(true)
    }
    for (const [callIndex, call] of hostedCalls.entries()) {
      const { trace: hostedTrace, logResult } = hostedToolTrace(call, modelCallIndex)
      const hostedParentToolId = text(options.parentToolId || record(toolContext.observability).toolCallId)
      hostedTrace.parentToolId = hostedParentToolId
      toolChain.push(hostedTrace)
      toolsUsed.push(text(hostedTrace.name))
      const now = Date.now()
      const logTrace = options.logTrace || record(toolContext.observability).trace
      modelLogStore.recordToolCall(logTrace, {
        modelCallId: text(options.modelCallId || record(logTrace).currentModelCallId),
        parentToolId: hostedParentToolId,
        round: modelCallIndex,
        callIndex: callIndex + 1,
        toolCallId: call.id,
        toolName: hostedTrace.name,
        source: hostedTrace.source,
        category: hostedTrace.category,
        status: hostedTrace.status,
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        delivery: hostedTrace.delivery,
        requiresFinalReply: true,
        arguments: hostedTrace.arguments,
        result: logResult,
        resultChars: hostedTrace.resultChars,
        error: hostedTrace.error,
        metadata: hostedTrace.metadata,
      })
    }
  }
  recordModelCall(response)
  if (aggregatedHostedWebSearch) {
    toolContext.searchCapabilities = {
      webSearch: {
        hosted: async (query: string, _args: UnknownRecord, searchContext: UnknownRecord = {}) => {
          const workerMessages: UnknownRecord[] = [
            { role: "system", content: "Use the available hosted web search once to collect current evidence for the query. Return a concise factual digest grounded in the retrieved sources." },
            { role: "user", content: query },
          ]
          const runTrace = record(trace)
          const parentModelCallId = text(runTrace.currentModelCallId)
          const workerChannel = modelChannel({
            ...channel,
            modelConfig: {
              ...modelConfig,
              responses: { ...responsesConfig, stateMode: "local", store: false },
            },
            responsesRuntime: {
              webSearchAllowed: true,
              fileSearchAllowed: false,
              toolSearchAllowed: false,
              stateMode: "local",
              previousResponseId: "",
            },
          })
          let hostedResponse
          try {
            hostedResponse = await adapterRegistry.sendMessage({
              channel: workerChannel,
              messages: modelMessages(workerMessages),
              tools: [],
              toolChoice: "required",
              event: options.e,
              maxTokens,
              signal: agentContext.signal instanceof AbortSignal ? agentContext.signal : undefined,
              source,
              purpose: "search-aggregate",
              taskName: text(step.task),
              trace,
              parentToolId: text(record(searchContext.observability).toolCallId || record(toolContext.observability).toolCallId),
              ...modelCallMetadata(workerMessages, "parallel-hosted-search", toolRounds),
            })
            recordModelCall(hostedResponse, {
              observeTurn: false,
              updateState: false,
              logTrace: runTrace,
              modelCallId: text(runTrace.currentModelCallId),
              parentToolId: text(record(searchContext.observability).toolCallId || record(toolContext.observability).toolCallId),
            })
          } finally {
            // 子请求需要共享同一 run 的单调序号与用量，但不能抢走父工具所属的
            // 主模型调用 ID；父工具结束后仍应挂回发起它的那次模型请求。
            if (Object.keys(runTrace).length) runTrace.currentModelCallId = parentModelCallId
          }
          const sources = [
            ...(hostedResponse.hostedSearchSources || []),
            ...(hostedResponse.hostedToolCalls || []).flatMap(call => call.sources || []),
          ]
          const seen = new Set<string>()
          return {
            text: text(hostedResponse.text).trim(),
            sources: sources.filter(item => {
              if (!item.url || seen.has(item.url)) return false
              seen.add(item.url)
              return true
            }).map(item => ({ title: item.title || item.url, url: item.url, content: "" })),
          }
        },
      },
    }
  }
  const workingMessages = [...messages]
  const workingRecoveryMessages = hasSeparateRecoveryContext ? [...recoveryMessages] : workingMessages
  const executeToolRoundWithReplay = async (input: Omit<Parameters<typeof executeToolRound>[0], "workingMessages">) => {
    const before = workingMessages.length
    const result = await executeToolRound({ ...input, workingMessages })
    if (workingRecoveryMessages !== workingMessages) workingRecoveryMessages.push(...workingMessages.slice(before))
    return result
  }

  const canExecuteToolRound = (): boolean => {
    if (response.stopReason !== "tool_calls" || !response.toolCalls?.length) return false
    if (toolRounds < maxToolRounds) return true
    if (!searchDeliveryRequired) return false
    return searchDeliveryExtraRoundsUsed < 2
      && response.toolCalls.every(call => call.name === "message_send")
  }

  while (canExecuteToolRound()) {
    if (toolRounds >= maxToolRounds) searchDeliveryExtraRoundsUsed++
    toolRounds++
    executionRuntime.state.turnCount = toolRounds
    const selectedToolCalls = hasAgentContext
      ? response.toolCalls.slice(0, Math.max(1, number(agentContext.maxToolCallsPerRound, 1)))
      : response.toolCalls
    const toolCalls = appendPlannedMessageParts(
      applyRuntimeToolIntent(selectedToolCalls.map(record), text(prompt)),
      pendingMessageAppendParts,
    )
    agentTurn.beginToolExecution()
    const roundResult = await executeToolRoundWithReplay({ toolCalls, assistantText: response.text, assistantProtocol: response.protocol, toolContext, round: toolRounds })
    const requestedTraces = roundResult.traces
    pendingMessageAppendParts = mergePlannedParts(pendingMessageAppendParts, plannedMessageAppendParts(requestedTraces))
    const automaticParts = plannedMessageParts(requestedTraces)
    let automaticDeliveryTraces: UnknownRecord[] = []
    if (automaticParts.length && currentTools().some(tool => tool.name === "message_send")) {
      const parentToolId = text(requestedTraces.find(hasMessageSendPlan)?.id)
      const automaticRound = await executeToolRoundWithReplay({
        toolCalls: [{ id: `${parentToolId || "media"}:message_send`, name: "message_send", arguments: { parts: automaticParts } }],
        assistantText: "",
        toolContext: {
          ...toolContext,
          observability: { ...record(toolContext.observability), toolCallId: parentToolId },
        },
        round: toolRounds,
      })
      automaticDeliveryTraces = automaticRound.traces
    }
    const traces = [...requestedTraces, ...automaticDeliveryTraces]
    toolChain.push(...traces)
    toolsUsed.push(...traces.map(item => text(item.name)))
    const searchesNeedingModelDelivery = requestedTraces.some(item => isSearchToolTrace(item, text(prompt)) && !hasMessageSendPlan(item))
    if (searchesNeedingModelDelivery) {
      searchDeliveryRequired = true
      searchDeliveryStatus = "required"
    }
    if (traces.some(item => item.name === "message_send")) {
      searchDeliveryAttempted = true
      searchDeliveryStatus = hasSuccessfulMediaDelivery(traces) ? "sent" : "failed"
      if (hasSuccessfulMediaDelivery(traces)) pendingMessageAppendParts = []
    }
    if (traces.some(item => number(record(item.metadata).mediaPartCount) > 0)) mediaResourceSeen = true
    const hasPendingQuota = traces.some(item => item.status === "ok" && number(item.remainingCount) > 0 && record(item.metadata).background !== true)
    const hasPendingActionQuota = traces.some(item => item.status === "ok"
      && item.effect !== "read"
      && number(item.remainingCount) > 0
      && record(item.metadata).background !== true)
    if (roundResult.stopReason || executionRuntime.shouldFinalize()) {
      toolLimitReached = true
      response = { ...response, text: "", toolCalls: [] }
      break
    }
    if (automaticDeliveryTraces.length && hasSuccessfulMediaDelivery(automaticDeliveryTraces)) {
      searchDeliveryAttempted = true
      searchDeliveryStatus = "sent"
      agentTurn.requestFinalReply(shouldContinueAfterAutomaticDelivery(requestedTraces))
    }
    // continueConversation 只锁存“最终必须回复”，不会把当前工具轮当成最终轮。
    // 模型仍可继续调用后续工具；只有全部自动计划都允许静默时才提前结束。
    const mixedAutomaticBatchCanFinishSilently = automaticDeliveryTraces.length > 0
      && hasSuccessfulMediaDelivery(automaticDeliveryTraces)
      && agentTurn.state.finalReplyRequired !== true
      && !hasPendingActionQuota
      && !searchesNeedingModelDelivery
      && requestedTraces.every(trace => hasMessageSendPlan(trace) || trace.requiresFinalReply === false)
    if (mixedAutomaticBatchCanFinishSilently) {
      singleAsyncToolCompleted = true
      beginFinalization("AUTOMATIC_MEDIA_DELIVERY_COMPLETED")
      response = { ...response, text: "", toolCalls: [] }
      break
    }
    // 投递完成即收束，但仅限本轮只有这一个工具的情况：多工具轮次里其余
    // 工具的结果还没回到模型，提前 break 会让最终回复基于不完整信息生成。
    if (traces.length === 1
      && hasSuccessfulMediaDelivery(traces)
      && traces[0].requiresFinalReply === false
      && agentTurn.state.finalReplyRequired !== true) {
      singleAsyncToolCompleted = true
      beginFinalization("MEDIA_DELIVERY_COMPLETED")
      response = { ...response, text: "", toolCalls: [] }
      break
    }
    const singleAsyncChain = traces.length === 1
      && toolChain.every(item => item.name === traces[0].name && ["ok", "accepted"].includes(text(item.status)) && item.requiresFinalReply === false)
    if (singleAsyncChain
      && ["ok", "accepted"].includes(text(traces[0].status))
      && traces[0].requiresFinalReply === false
      && agentTurn.state.finalReplyRequired !== true
      && !hasPendingQuota) {
      singleAsyncToolCompleted = true
      response = { ...response, text: "", toolCalls: [] }
      break
    }
    const phase = searchDeliveryRequired ? "search-delivery" : "after-tools"
    const nextMessages = searchDeliveryRequired
      ? buildSearchDeliveryMessages(workingMessages)
      : agentTurn.state.finalReplyRequired
        ? buildAgentLoopContinuationMessages(workingMessages)
        : workingMessages
    const boundedMessages = budgeted(nextMessages, phase)
    const recoveryNextMessages = searchDeliveryRequired
      ? buildSearchDeliveryMessages(workingRecoveryMessages)
      : agentTurn.state.finalReplyRequired
        ? buildAgentLoopContinuationMessages(workingRecoveryMessages)
        : workingRecoveryMessages
    const boundedRecoveryMessages = configuredResponsesStateMode === "auto"
      ? budgeted(recoveryNextMessages, `responses-recovery-${phase}`)
      : boundedMessages
    await executionRuntime.waitForNextRound(agentContext.signal instanceof AbortSignal ? agentContext.signal : undefined)
    const availableAfterTools = currentTools()
    const forcedToolName = searchDeliveryRequired ? "message_send" : ""
    const afterTools = forcedToolName
      ? availableAfterTools.filter(tool => tool.name === forcedToolName)
      : availableAfterTools
    if (forcedToolName && !afterTools.length) {
      searchDeliveryStatus = "unavailable"
      response = { ...response, text: "搜索结果无法发送：message_send 当前未启用或没有权限。", toolCalls: [] }
      break
    }
    if (searchDeliveryRequired) searchDeliveryAttempted = true
    agentTurn.beginModelDecision()
    conversationLog.modelRequest(root, {
      channel: channel.id,
      adapter: adapter.id,
      messages: boundedMessages.length,
      tools: afterTools.length,
      maxTokens,
      timeoutMs: channel.timeoutMs,
      stream: channel.stream,
      phase,
    })
    response = await adapterRegistry.sendMessage({
      channel: modelChannel(channel),
      messages: modelMessages(boundedMessages),
      ...(configuredResponsesStateMode === "auto" ? { replayMessages: modelMessages(boundedRecoveryMessages) } : {}),
      tools: toolDefinitions(afterTools),
      toolChoice: forcedToolName ? { type: "function", name: forcedToolName } : undefined,
      event: options.e,
      maxTokens,
      signal: agentContext.signal instanceof AbortSignal ? agentContext.signal : undefined,
      source,
      purpose,
      taskName: text(step.task),
      trace,
      parentToolId: text(record(toolContext.observability).toolCallId),
      ...modelCallMetadata(boundedMessages, phase, toolRounds),
    })
    recordModelCall(response)
  }

  // 结构化异常终态不再进入工具循环，也不再次请求模型。尤其是 max_tokens
  // 携带的工具块可能已经截断，任何情况下都不能作为完整调用执行。
  const discardedTerminalToolCalls = response.stopReason !== "tool_calls" && Boolean(response.toolCalls?.length)
  const terminalText = normalizeResponseText(response.text) ? text(response.text).trim() : ""
  if (response.stopReason === "tool_calls" && !response.toolCalls?.length) {
    beginFinalization("MODEL_TOOL_CALLS_MISSING")
    response = {
      ...response,
      text: terminalText || "模型请求调用工具，但没有返回完整的可执行调用。",
      toolCalls: [],
    }
  } else if (response.stopReason === "max_tokens") {
    beginFinalization("MODEL_MAX_TOKENS")
    const note = discardedTerminalToolCalls
      ? "模型输出达到上限，工具参数可能不完整，因此没有执行该工具。"
      : "模型回复达到输出上限，内容可能不完整。"
    response = { ...response, text: [terminalText, note].filter(Boolean).join("\n\n"), toolCalls: [] }
  } else if (response.stopReason === "pause_turn") {
    beginFinalization("MODEL_PAUSE_TURN_UNSUPPORTED")
    response = {
      ...response,
      text: [terminalText, "模型服务暂停了当前轮次；当前通道暂不支持原样续跑，本次没有继续执行工具。"].filter(Boolean).join("\n\n"),
      toolCalls: [],
    }
  } else if (response.stopReason === "refusal") {
    beginFinalization("MODEL_REFUSAL")
    response = { ...response, text: terminalText || "模型拒绝了本次请求。", toolCalls: [] }
  } else if (response.stopReason === "error") {
    beginFinalization("MODEL_ERROR")
    response = { ...response, text: terminalText || "模型未能完成本次请求，请稍后重试。", toolCalls: [] }
  } else if (response.stopReason === "unknown" && discardedTerminalToolCalls) {
    beginFinalization("MODEL_UNKNOWN_STOP_REASON")
    response = {
      ...response,
      text: [terminalText, "模型返回了无法识别的终止状态，因此没有执行其中的工具调用。"].filter(Boolean).join("\n\n"),
      toolCalls: [],
    }
  }

  const requiresFinalReply = !singleAsyncToolCompleted
  let responseText = text(response.text).trim()
  if (searchDeliveryRequired && !hasSuccessfulMediaDelivery(toolChain) && !response.toolCalls?.length && searchDeliveryStatus !== "unavailable") {
    searchDeliveryStatus = searchDeliveryAttempted ? "model-did-not-send" : "not-attempted"
    response = { ...response, text: "搜索结果未能通过 message_send 发送，请稍后重试。", toolCalls: [] }
    responseText = text(response.text).trim()
  }
  const directMediaCodes = findUnsupportedMediaCQCodes(responseText)
  mediaDirectOutputDetected = directMediaCodes.length > 0
  // 纠正只在一个客观信号下触发：模型把媒体 CQ 码当成普通文字输出了。
  // 是否发送媒体由模型自己判断，运行时不再从候选或用户措辞推断意图。
  if (requiresFinalReply
    && response.stopReason === "end_turn"
    && directMediaCodes.length
    && !hasSuccessfulMediaDelivery(toolChain)
    && toolUseEnabled
    && toolRounds < maxToolRounds
    && !mediaCorrectionAttempted
    && mediaCorrectionTools().some(tool => tool.name === "message_send")) {
    mediaCorrectionAttempted = true
    const correctionTools = mediaCorrectionTools()
    const correctionBaseMessages = workingMessages
    const correctionMessages = budgeted(directMediaCodes.length
      ? buildMediaDeliveryCorrectionMessages(correctionBaseMessages, responseText, directMediaCodes)
      : buildMediaSelectionCorrectionMessages(correctionBaseMessages, responseText), "media-correction")
    const correctionRecoveryMessages = configuredResponsesStateMode === "auto"
      ? budgeted(directMediaCodes.length
        ? buildMediaDeliveryCorrectionMessages(workingRecoveryMessages, responseText, directMediaCodes)
        : buildMediaSelectionCorrectionMessages(workingRecoveryMessages, responseText), "responses-recovery-media-correction")
      : correctionMessages
    conversationLog.modelRequest(root, {
      channel: channel.id,
      adapter: adapter.id,
      messages: correctionMessages.length,
      tools: correctionTools.length,
      maxTokens,
      timeoutMs: channel.timeoutMs,
      stream: channel.stream,
      phase: directMediaCodes.length ? "media-delivery-correction" : "media-selection-correction",
    })
    try {
      const correctionResponse = await adapterRegistry.sendMessage({
        channel: modelChannel(channel),
        messages: modelMessages(correctionMessages),
        ...(configuredResponsesStateMode === "auto" ? { replayMessages: modelMessages(correctionRecoveryMessages) } : {}),
        tools: toolDefinitions(correctionTools),
        event: options.e,
        maxTokens,
        signal: agentContext.signal instanceof AbortSignal ? agentContext.signal : undefined,
        source,
        purpose,
        taskName: text(step.task),
        trace,
        parentToolId: text(record(toolContext.observability).toolCallId),
        ...modelCallMetadata(correctionMessages, directMediaCodes.length ? "media-delivery-correction" : "media-selection-correction", toolRounds),
      })
      recordModelCall(correctionResponse)
      if (correctionResponse.stopReason === "tool_calls" && correctionResponse.toolCalls?.length) {
        toolRounds++
        executionRuntime.state.turnCount = toolRounds
        const correctionRound = await executeToolRoundWithReplay({
          toolCalls: correctionResponse.toolCalls,
          assistantText: correctionResponse.text,
          assistantProtocol: correctionResponse.protocol,
          toolContext,
          round: toolRounds,
        })
        toolChain.push(...correctionRound.traces)
        toolsUsed.push(...correctionRound.traces.map(item => text(item.name)))
        mediaCorrectionStatus = hasSuccessfulMediaDelivery(toolChain) ? "sent" : "tool-called-without-media-delivery"
        const correctionSentWithoutReply = hasSuccessfulMediaDelivery(correctionRound.traces)
          && correctionRound.traces.length === 1
          && correctionRound.traces[0].requiresFinalReply === false
        if (correctionSentWithoutReply) singleAsyncToolCompleted = true
        toolFinalizationRequired = !correctionSentWithoutReply
        beginFinalization(directMediaCodes.length ? "MEDIA_DELIVERY_CORRECTION" : "MEDIA_SELECTION_CORRECTION")
        response = { ...correctionResponse, text: "", toolCalls: [] }
        responseText = ""
      } else if (correctionResponse.stopReason !== "end_turn") {
        mediaCorrectionStatus = "failed"
        toolFinalizationRequired = false
        beginFinalization(`MODEL_${correctionResponse.stopReason.toUpperCase()}`)
        response = {
          ...correctionResponse,
          text: normalizeResponseText(correctionResponse.text)
            ? correctionResponse.text
            : "模型未能完成媒体发送纠正，本次没有执行新的工具调用。",
          toolCalls: [],
        }
        responseText = text(response.text).trim()
      } else if (findUnsupportedMediaCQCodes(correctionResponse.text || "").length) {
        mediaCorrectionStatus = "failed"
        toolFinalizationRequired = false
        beginFinalization(directMediaCodes.length ? "MEDIA_DELIVERY_CORRECTION" : "MEDIA_SELECTION_CORRECTION")
        response = { ...correctionResponse, text: "媒体未能发送成功，请稍后重试。", toolCalls: [] }
        responseText = text(response.text).trim()
      } else {
        mediaCorrectionStatus = "corrected"
        response = correctionResponse
        responseText = text(response.text).trim()
      }
    } catch (error) {
      mediaCorrectionStatus = "failed"
      hostRuntime.logger?.warn?.(`[yui-chat] 媒体发送纠正失败：${errorSummary(error)}`)
      toolFinalizationRequired = false
      beginFinalization(directMediaCodes.length ? "MEDIA_DELIVERY_CORRECTION" : "MEDIA_SELECTION_CORRECTION")
      response = { ...response, text: "媒体未能发送成功，请稍后重试。", toolCalls: [] }
      responseText = text(response.text).trim()
    }
  }

  if (response.toolCalls?.length && toolRounds >= maxToolRounds) {
    toolLimitReached = true
    beginFinalization("MAX_TURNS")
  }
  const automaticDeliveryNeedsFinalReply = agentTurn.state.finalReplyRequired === true
    && toolRounds > 0
    && !normalizeResponseText(responseText)
  if (automaticDeliveryNeedsFinalReply && agentTurn.beginEmptyFinalRecovery("AUTOMATIC_MEDIA_DELIVERY_COMPLETED")) {
    executionRuntime.enterFinalization("AUTOMATIC_MEDIA_DELIVERY_COMPLETED")
  }
  const needsFinalization = requiresFinalReply && toolRounds > 0 && (!responseText || automaticDeliveryNeedsFinalReply)
  if (requiresFinalReply && (toolLimitReached || needsFinalization || toolFinalizationRequired)) {
    toolFinalizationAttempted = true
    if (agentTurn.state.phase !== "finalizing") beginFinalization(text(executionRuntime.state.finalizationReason) || "EMPTY_TOOL_RESPONSE")
    const automaticDeliveryContinuation = agentTurn.state.finalReplyRequired === true
      || text(executionRuntime.state.finalizationReason) === "AUTOMATIC_MEDIA_DELIVERY_COMPLETED"
    const finalizationMessages = budgeted(
      automaticDeliveryContinuation
        ? buildAutomaticDeliveryContinuationMessages(workingMessages)
        : buildToolLimitFinalizationMessages(
          workingMessages,
          text(executionRuntime.state.finalizationReason),
        ),
      "finalization",
    )
    const finalizationRecoveryMessages = configuredResponsesStateMode === "auto"
      ? budgeted(
        automaticDeliveryContinuation
          ? buildAutomaticDeliveryContinuationMessages(workingRecoveryMessages)
          : buildToolLimitFinalizationMessages(
            workingRecoveryMessages,
            text(executionRuntime.state.finalizationReason),
          ),
        "responses-recovery-finalization",
      )
      : finalizationMessages
    conversationLog.modelRequest(root, {
      channel: channel.id,
      adapter: adapter.id,
      messages: finalizationMessages.length,
      tools: 0,
      maxTokens,
      timeoutMs: channel.timeoutMs,
      stream: channel.stream,
      phase: "tool-finalization",
    })
    try {
      response = await adapterRegistry.sendMessage({
        channel: modelChannel(channel),
        messages: modelMessages(finalizationMessages),
        ...(configuredResponsesStateMode === "auto" ? { replayMessages: modelMessages(finalizationRecoveryMessages) } : {}),
        tools: [],
        event: options.e,
        maxTokens,
        signal: agentContext.signal instanceof AbortSignal ? agentContext.signal : undefined,
        source,
        purpose,
        taskName: text(step.task),
        trace,
        parentToolId: text(record(toolContext.observability).toolCallId),
        ...modelCallMetadata(finalizationMessages, "tool-finalization", toolRounds),
      })
      recordModelCall(response)
    } catch (error) {
      toolFinalizationError = errorSummary(error, 500)
      hostRuntime.logger?.warn?.(`[yui-chat] 工具结果收束失败：${toolFinalizationError}`)
      response = { ...response, text: "", toolCalls: [] }
    }
  }

  agentTurn.complete(!requiresFinalReply || !normalizeResponseText(response.text))
  const summary = executionRuntime.summary()
  return {
    id: response.id,
    stepId: text(step.id || step.task || "step"),
    mode: text(step.mode || "final"),
    channel: channel.id,
    adapter: adapter.id,
    provider: text(record(channel.provider).name || record(channel.modelConfig).apiProvider),
    text: requiresFinalReply ? response.text || "" : "",
    requiresFinalReply,
    toolLimitReached,
    toolFinalizationAttempted,
    toolFinalizationError,
    toolFinalizationReason: text(executionRuntime.state.finalizationReason),
    modelStopReason: response.stopReason,
    agentTurn: agentTurn.summary(),
    mediaCorrectionAttempted,
    mediaCorrectionStatus,
    mediaDirectOutputDetected,
    mediaDeliveryRequired: mediaResourceSeen,
    mediaCandidateSeen: mediaResourceSeen,
    searchDeliveryRequired,
    searchDeliveryAttempted,
    searchDeliveryStatus,
    toolDeduplicated: toolChain.some(item => item.deduplicated === true),
    toolRounds,
    toolsUsed: [...new Set(toolsUsed)],
    toolChain,
    hostedSearchSources: [...hostedSearchSources.values()],
    responseState: adapter.protocol === "responses" ? {
      key: responseStateKey,
      mode: configuredResponsesStateMode,
      previousResponseId: responsesUsesUpstreamState(configuredResponsesStateMode) ? text(response.upstreamResponseId).trim() : "",
      clear: !responsesUsesUpstreamState(configuredResponsesStateMode) || !text(response.upstreamResponseId).trim(),
      provider: text(record(channel.provider).name || modelConfig.apiProvider),
      model: text(channel.model || modelConfig.modelIdentifier),
    } : {},
    execution: summary,
    usage,
    modelCalls,
  }
}
