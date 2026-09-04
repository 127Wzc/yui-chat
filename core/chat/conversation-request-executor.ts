import crypto from "node:crypto"
import { configStore } from "../../config/store.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import { prepareMediaForVision } from "../media/media-cache.js"
import { recentImageRecallModeForPrompt, resolveMediaContext } from "../message/media-context.js"
import { recentContextStore } from "./recent-context.js"
import { isEmptyResponse, normalizeResponseText } from "./response-pipeline.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { conversationLog } from "./conversation-log.js"
import { applyInputFilters } from "../../filters/message/message-filter-service.js"
import { conversationStore } from "./conversation-store.js"
import { modelLogStore } from "../observability/model-log.js"
import type { UnknownRecord } from "../message/types.js"
import {
  addUsage,
  emptyUsage,
  nowIso,
  scopeFor,
  summarizeMediaForResult,
} from "./chat-support.js"
import { errorSummary } from "../shared/error-details.js"

export interface ConversationRequestRuntime {
  conversations: Map<string, unknown>
  enqueueConversationMutation<T>(operation: () => Promise<T> | T): Promise<T>
  captureConversationVersion(event: unknown, key: string): unknown
  conversationVersionCurrent(version: unknown): boolean
  releaseConversationVersion(version: unknown): void
  prune(config: unknown): void
  waitForConversationMutations(): Promise<void>
  getHistory(key: string, version?: unknown): Promise<unknown[]>
  getConversation(key: string, version?: unknown): Promise<UnknownRecord>
  conversationKey(event: unknown, channelId: string): string
  runObservedStep(options: UnknownRecord): Promise<UnknownRecord>
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

function errorMessage(error: unknown): string {
  return errorSummary(error)
}

function withoutCause(value: UnknownRecord): UnknownRecord {
  const { cause: _cause, responseState: _responseState, ...rest } = value
  return rest
}

function updatedProtocolState(value: unknown, responseStateValue: unknown): UnknownRecord {
  const current = record(value)
  const responseState = record(responseStateValue)
  const key = text(responseState.key).trim()
  if (!key) return current
  const responses = { ...record(current.responses) }
  if (responseState.clear === true || !text(responseState.previousResponseId).trim()) delete responses[key]
  else responses[key] = {
    previousResponseId: text(responseState.previousResponseId).trim(),
    provider: text(responseState.provider),
    model: text(responseState.model),
    updatedAt: Date.now(),
  }
  return { ...current, responses }
}

class ConversationTaskError extends Error {
  readonly task: UnknownRecord

  constructor(message: string, cause: unknown, task: UnknownRecord) {
    super(message, { cause })
    this.name = "ConversationTaskError"
    this.task = task
  }
}

function traceMetadata(result: UnknownRecord): UnknownRecord {
  const execution = record(result.execution)
  return {
    requiresFinalReply: result.requiresFinalReply,
    toolLimitReached: Boolean(result.toolLimitReached),
    toolFinalizationAttempted: Boolean(result.toolFinalizationAttempted),
    toolFinalization: result.toolFinalizationError ? "failed" : result.toolFinalizationAttempted ? "ok" : "not-needed",
    toolDeduplicated: Boolean(result.toolDeduplicated),
    toolFinalizationReason: text(result.toolFinalizationReason),
    mediaCorrectionAttempted: Boolean(result.mediaCorrectionAttempted),
    mediaCorrectionStatus: text(result.mediaCorrectionStatus || "not-needed"),
    mediaDirectOutputDetected: Boolean(result.mediaDirectOutputDetected),
    mediaDeliveryRequired: Boolean(result.mediaDeliveryRequired),
    mediaCandidateSeen: Boolean(result.mediaCandidateSeen),
    searchDeliveryRequired: Boolean(result.searchDeliveryRequired),
    searchDeliveryAttempted: Boolean(result.searchDeliveryAttempted),
    searchDeliveryStatus: text(result.searchDeliveryStatus || "not-needed"),
    execution: execution.phase ? {
      turnCount: execution.turnCount,
      toolCallCount: execution.toolCallCount,
      sideEffectCount: execution.sideEffectCount,
      guardBlockStreak: execution.guardBlockStreak,
      noProgressStreak: execution.noProgressStreak,
      phase: execution.phase,
      finalizationReason: execution.finalizationReason,
    } : {},
  }
}

function publicStepResult(stepResults: UnknownRecord[]): UnknownRecord[] {
  return stepResults.map(withoutCause)
}

/**
 * 对话请求执行器：负责请求级生命周期和会话写入，不负责模型渠道选择或工具循环。
 * 所有跨层状态操作都通过 ConversationRequestRuntime 注入，避免重新形成大而全的服务类。
 */
export async function sendConversation(
  event: unknown,
  promptValue: unknown,
  optionsValue: unknown = {},
  runtime: ConversationRequestRuntime,
): Promise<UnknownRecord> {
  const options = record(optionsValue)
  const config = record(await configStore.load())
  const requestStarted = Date.now()
  const originalPrompt = text(promptValue)
  const source = text(options.source) || "chat"
  const purpose = text(options.purpose) || (source === "subagent" ? "subagent" : "chat")
  const trace = modelLogStore.createTrace({
    event,
    source,
    purpose,
    prompt: originalPrompt,
    metadata: { transient: options.transient === true },
  })
  const failTrace = (error: unknown): never => {
    modelLogStore.finishTrace(trace, { status: "error", error: errorMessage(error) })
    throw error
  }

  conversationLog.started(config, {
    scope: scopeFor(event),
    source,
    promptChars: originalPrompt.length,
  })

  const skipInputFilters = options.applyInputFilters === false
  let input
  try {
    input = skipInputFilters
      ? { text: originalPrompt, blocked: false, traces: [] as UnknownRecord[] }
      : await applyInputFilters(originalPrompt, { event, e: event, config, source })
  } catch (error) {
    return failTrace(error)
  }
  if (input.blocked) {
    modelLogStore.finishTrace(trace, { status: "blocked", response: "", metadata: { reason: input.reason || "input-filter" } })
    conversationLog.completed(config, {
      scope: scopeFor(event),
      channel: text(options.channelId || record(config.chat).defaultChannel),
      durationMs: Date.now() - requestStarted,
      tools: 0,
      usage: emptyUsage(),
    })
    return {
      id: null,
      channel: text(options.channelId || record(config.chat).defaultChannel),
      adapter: "",
      source: text(options.source),
      conversationKey: "",
      prompt: originalPrompt,
      media: null,
      text: "",
      inputBlocked: true,
      inputBlockReason: input.reason || "消息已被输入过滤器拦截。",
      filterTraces: input.traces || [],
      toolRounds: 0,
      toolChain: [],
      usage: emptyUsage(),
      steps: [],
    }
  }

  const prompt = input.text
  let media: unknown = null
  try {
    if (record(config.mediaRecognition).enabled !== false) {
      const resolved = await resolveMediaContext(event, prompt, config)
      const hasEligibleImage = resolved.attachments.some(item => item.kind === "image" && item.visionEligible !== false)
      const recallMode = hasEligibleImage ? "none" : recentImageRecallModeForPrompt(prompt)
      if (recallMode !== "none") {
        const recentImage = recentContextStore.findRecentImage(event, {
          ...(recallMode === "adjacent" ? { maxRowsBack: 1 } : {}),
          prompt,
        })
        if (recentImage) {
          resolved.attachments.push({
            kind: "image",
            url: recentImage.url,
            source: recentImage.source,
            messageId: recentImage.messageId,
            sender: { userId: recentImage.userId, name: recentImage.name },
            visionEligible: true,
          })
        }
      }
      media = await prepareMediaForVision(resolved, config)
    }
  } catch (error) {
    return failTrace(error)
  }

  const chat = record(config.chat)
  const step: UnknownRecord = { id: "reply", task: text(chat.defaultTask) || "replyer", mode: "final" }
  let firstChannel
  try {
    firstChannel = await providerResolver.resolve({
      taskName: text(step.task),
      channelId: text(options.channelId || chat.defaultChannel),
    })
    if (!firstChannel) throw new Error("无可用模型渠道")
  } catch (error) {
    return failTrace(error)
  }

  const key = runtime.conversationKey(event, firstChannel.id)
  if (trace && typeof trace === "object") (trace as unknown as UnknownRecord).conversationKey = key
  const conversationVersion = runtime.captureConversationVersion(event, key)
  try {
    runtime.prune(config)
    // 清理操作先进入同一队列；新请求必须等清理完成，避免旧历史在本轮结束时写回。
    await runtime.waitForConversationMutations()
    let conversation: UnknownRecord
    let history: unknown[]
    try {
      conversation = record(await runtime.getConversation(key, conversationVersion))
      history = list(conversation.history)
    } catch (error) {
      return failTrace(error)
    }

    const result = await runtime.runObservedStep({
      e: event,
      prompt,
      config,
      history,
      protocolState: record(conversation.protocolState),
      step,
      channelId: options.channelId,
      prior: [],
      index: 0,
      media,
      source,
      purpose,
      extraSystemPrompt: text(options.extraSystemPrompt),
      disableTools: options.disableTools === true,
      trace,
    })
    const stepResults = [record(result)]
    if (result.status === "error") {
      const resultError = record(result.error)
      const message = text(resultError.message || "unknown error")
      const diagnostic = errorSummary(result.cause || result.error || message)
      modelLogStore.finishTrace(trace, { status: "error", error: diagnostic, metadata: { step: result.stepId, errorDetails: record(resultError.details) } })
      conversationLog.failed(config, {
        scope: scopeFor(event),
        step: result.stepId,
        channel: result.channel,
        adapter: result.adapter,
        attempts: list(result.attempts).length,
        error: diagnostic,
      })
      hostRuntime.logger?.error?.(`[yui-chat] task ${text(result.stepId)} failed: ${diagnostic}`)
      throw new ConversationTaskError(`Task ${text(result.stepId)} failed: ${message}`, result.cause, {
        name: text(step.task),
        failedStep: text(result.stepId),
        steps: publicStepResult(stepResults),
      })
    }

    const successfulSteps = stepResults.filter(item => item.status === "ok")
    const final = [...successfulSteps].reverse().find(item => text(item.mode) === "final" && text(item.text)) || successfulSteps.at(-1) || {}
    const finalRequiresFinalReply = final.requiresFinalReply !== false
    const finalToolChain = list(final.toolChain).map(record)
    const errorSteps = stepResults.filter(item => item.status === "error")
    const rawFinalText = text(final.text) || (finalRequiresFinalReply
      ? errorSteps.length
        ? `默认任务没有可用回复：${errorSteps.map(item => `${text(item.stepId)} ${text(record(item.error).message)}`).join("；")}`
        : finalToolChain.length
          ? final.toolLimitReached ? "工具调用已达到本轮上限，但模型未生成最终说明。" : "工具已执行，但模型未生成最终说明。"
          : "模型没有返回文本。"
      : "")
    const finalText = normalizeResponseText(rawFinalText)

    conversationLog.completed(config, {
      scope: scopeFor(event),
      channel: text(final.channel || firstChannel.id),
      durationMs: Date.now() - requestStarted,
      tools: finalToolChain.length,
      usage: final.usage,
      requiresFinalReply: finalRequiresFinalReply,
      toolLimitReached: Boolean(final.toolLimitReached),
      toolFinalizationAttempted: Boolean(final.toolFinalizationAttempted),
      toolFinalizationError: text(final.toolFinalizationError),
      toolDeduplicated: Boolean(final.toolDeduplicated),
      toolFinalizationReason: text(final.toolFinalizationReason),
      mediaCorrectionAttempted: Boolean(final.mediaCorrectionAttempted),
      mediaCorrectionStatus: text(final.mediaCorrectionStatus || "not-needed"),
      mediaDirectOutputDetected: Boolean(final.mediaDirectOutputDetected),
      mediaDeliveryRequired: Boolean(final.mediaDeliveryRequired),
      mediaCandidateSeen: Boolean(final.mediaCandidateSeen),
      searchDeliveryRequired: Boolean(final.searchDeliveryRequired),
      searchDeliveryAttempted: Boolean(final.searchDeliveryAttempted),
      searchDeliveryStatus: text(final.searchDeliveryStatus || "not-needed"),
      execution: final.execution || {},
    })
    modelLogStore.finishTrace(trace, {
      status: isEmptyResponse(rawFinalText) ? "silent" : "ok",
      response: finalText,
      metadata: {
        ...traceMetadata(final),
        steps: stepResults.map(item => ({ stepId: item.stepId, status: item.status })),
      },
    })

    const resultPayload = (): UnknownRecord => ({
      id: final.id,
      channel: text(final.channel || firstChannel.id),
      adapter: final.adapter,
      source: text(options.source),
      conversationKey: key,
      prompt,
      media: summarizeMediaForResult(media),
      text: finalText,
      requiresFinalReply: finalRequiresFinalReply,
      toolLimitReached: Boolean(final.toolLimitReached),
      toolFinalizationAttempted: Boolean(final.toolFinalizationAttempted),
      toolDeduplicated: Boolean(final.toolDeduplicated),
      toolFinalizationReason: text(final.toolFinalizationReason),
      mediaCorrectionAttempted: Boolean(final.mediaCorrectionAttempted),
      mediaCorrectionStatus: text(final.mediaCorrectionStatus || "not-needed"),
      mediaDirectOutputDetected: Boolean(final.mediaDirectOutputDetected),
      mediaDeliveryRequired: Boolean(final.mediaDeliveryRequired),
      mediaCandidateSeen: Boolean(final.mediaCandidateSeen),
      searchDeliveryRequired: Boolean(final.searchDeliveryRequired),
      searchDeliveryAttempted: Boolean(final.searchDeliveryAttempted),
      searchDeliveryStatus: text(final.searchDeliveryStatus || "not-needed"),
      toolRounds: stepResults.reduce((sum, item) => sum + number(item.toolRounds), 0),
      toolChain: finalToolChain,
      hostedSearchSources: list(final.hostedSearchSources),
      execution: final.execution || null,
      usage: final.usage || emptyUsage(),
      steps: publicStepResult(stepResults),
    })

    if (options.transient === true) return resultPayload()

    if (!isEmptyResponse(rawFinalText)) {
      const maxHistoryMessages = Math.max(2, number(chat.maxHistoryMessages, 12))
      const turn: UnknownRecord = {
        id: text(final.id) || crypto.randomUUID(),
        at: nowIso(),
        channel: text(final.channel || firstChannel.id),
        adapter: text(final.adapter),
        usage: final.usage || emptyUsage(),
        modelCalls: final.modelCalls || [],
        toolChain: finalToolChain,
      }
      const conversationWritten = await runtime.enqueueConversationMutation(async () => {
        if (!runtime.conversationVersionCurrent(conversationVersion)) return false
        const previousValue = runtime.conversations.get(key)
        const previous = record(previousValue)
        const baseHistory = Array.isArray(previousValue) ? previousValue : list(previous.history)
        const nextHistory = [
          ...baseHistory,
          { role: "user", content: prompt },
          { role: "assistant", content: finalText },
        ].slice(-maxHistoryMessages)
        const turns = [...list(previous.turns), turn].slice(-Math.max(1, Math.floor(maxHistoryMessages / 2)))
        const usage = emptyUsage()
        for (const item of turns) addUsage(usage, record(item).usage)
        const protocolState = updatedProtocolState(previous.protocolState, final.responseState)
        const toolCalls = turns.reduce((sum: number, item) => sum + list(record(item).toolChain).length, 0)
        runtime.conversations.set(key, {
          history: nextHistory,
          turns,
          usage,
          toolCalls,
          protocolState,
          lastSeen: Date.now(),
        })
        try {
          await conversationStore.save({ id: key, history: nextHistory, turns, usage, toolCalls, protocolState })
        } catch (error) {
          hostRuntime.logger?.warn?.("[yui-chat] 会话写入 SQLite 失败，内存会话继续可用", error)
        }
        return true
      })
      if (conversationWritten && options.persistMemory !== false && runtime.conversationVersionCurrent(conversationVersion)) {
        const { memoryStore } = await import("../../memory/store.js")
        await memoryStore.appendInteraction(event, prompt, finalText)
      }
    } else {
      await runtime.enqueueConversationMutation(async () => {
        if (!runtime.conversationVersionCurrent(conversationVersion)) return
        const previousValue = runtime.conversations.get(key)
        const previous = record(previousValue)
        const currentHistory = Array.isArray(previousValue) ? previousValue : list(previous.history || history)
        const protocolState = updatedProtocolState(previous.protocolState, final.responseState)
        const next = { ...previous, history: currentHistory, protocolState, lastSeen: Date.now() }
        runtime.conversations.set(key, next)
        try {
          if (Object.keys(record(final.responseState)).length) {
            await conversationStore.save({
              id: key,
              history: currentHistory,
              turns: list(previous.turns),
              usage: record(previous.usage),
              toolCalls: previous.toolCalls,
              protocolState,
            })
          } else await conversationStore.touch(key)
        } catch (error) {
          hostRuntime.logger?.warn?.("[yui-chat] 刷新 SQLite 会话活跃时间失败，内存会话继续可用", error)
        }
      })
    }
    return resultPayload()
  } finally {
    runtime.releaseConversationVersion(conversationVersion)
  }
}
