import crypto from "node:crypto"
import { configStore } from "../../config/store.js"
import { providerResolver } from "../../models/routing/provider-resolver.js"
import { prepareMediaForVision } from "../media/media-cache.js"
import { conversationImageFollowup, recentImageRecallMode, resolveMediaContext, refreshRecentImage, type ResolvedMediaContext } from "../message/media-context.js"
import { truncateTextToTokens } from "./token-budget.js"
import { recentContextStore } from "./recent-context.js"
import { isEmptyResponse, normalizeResponseText } from "./response-pipeline.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { conversationLog } from "./conversation-log.js"
import { applyInputFilters, type MessageFilterResult } from "../../filters/message/message-filter-service.js"
import { conversationStore } from "./conversation-store.js"
import { modelLogStore } from "../observability/model-log.js"
import type { UnknownRecord } from "../message/types.js"
import { artifactStore } from "../../tools/support/artifact-store.js"
import {
  addUsage,
  emptyUsage,
  nowIso,
  scopeFor,
  summarizeMediaForResult,
} from "./chat-support.js"
import { errorSummary } from "../shared/error-details.js"
import { completedToolTrace, toolHistoryMessages, toolHistoryResult, trimConversationHistory, type BackgroundToolCompletion } from "./tool-history.js"

export interface ConversationRequestRuntime {
  conversations: Map<string, unknown>
  enqueueConversationMutation<T>(operation: () => Promise<T> | T): Promise<T>
  retainConversationWrite(key: string, turnId: string, retry: (() => Promise<void>) | null): void
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

function withoutCause(value: UnknownRecord): UnknownRecord {
  const { cause: _cause, responseState: _responseState, historyUserContent: _history, imageReferences: _images, deliveredReplyText: _deliveredText, ...rest } = value
  return rest
}

function updatedProtocolState(value: unknown, responseStateValue: unknown, toolResultsVersion: number): UnknownRecord {
  const current = record(value)
  // 请求期间有后台结果写回时，该请求的上游状态没有见过新结果，不能覆盖它。
  if (number(current.toolResultsVersion) !== toolResultsVersion) return { ...current, responses: {} }
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
    replyDelivered: result.replyDelivered === true,
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
    modelLogStore.finishTrace(trace, { status: "error", error })
    throw error
  }

  conversationLog.started(config, {
    scope: scopeFor(event),
    source,
    promptChars: originalPrompt.length,
  })

  const skipInputFilters = options.applyInputFilters === false
  let input: Pick<MessageFilterResult, "text" | "blocked" | "traces"> & { reason?: string }
  try {
    input = skipInputFilters
      ? { text: originalPrompt, blocked: false, traces: [] as UnknownRecord[] }
      : await applyInputFilters(originalPrompt, { event, e: event, config, source })
  } catch (error) {
    return failTrace(error)
  }
  const blockedResult = (): UnknownRecord => {
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
  if (input.blocked) return blockedResult()

  const prompt = input.text
  let media: ResolvedMediaContext | null = null
  const mediaRecognition = record(config.mediaRecognition)
  const mediaEnabled = mediaRecognition.enabled !== false
  try {
    // 文字引用属于消息语义，不依赖媒体开关；所有普通对话入口使用相同规则。
    media = await resolveMediaContext(event, prompt, config, { quoteAsCurrent: true })
    if (media.quote?.text) {
      if (!skipInputFilters) {
        const quotedInput = await applyInputFilters(media.quote.text, { event, e: event, config, source, inputKind: "quote" })
        media.quote.text = quotedInput.text
        if (quotedInput.blocked) {
          input = quotedInput
          return blockedResult()
        }
      }
      const quoteBudget = Math.max(256, Math.min(4000, Math.floor(number(record(config.chat).inputTokenBudget, 6000) * 0.4)))
      const bounded = truncateTextToTokens(media.quote.text.slice(0, quoteBudget * 4), quoteBudget)
      if (bounded !== media.quote.text) media.quote.status = "partial"
      media.quote.text = bounded
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

    const sessionId = text(conversation.sessionId) || crypto.randomUUID()
    const turnId = crypto.randomUUID()
    const toolResultsVersion = number(record(conversation.protocolState).toolResultsVersion)
    const pendingBackground = new Map<string, BackgroundToolCompletion>()
    const observedToolChain: UnknownRecord[] = []
    let toolProgress: UnknownRecord = {}
    let historyCommitted = false
    const persistBackgroundCompletions = async (): Promise<void> => {
      if (!historyCommitted || !pendingBackground.size) return
      for (let attempt = 0; ; attempt++) {
        try {
          await runtime.enqueueConversationMutation(async () => {
            const completions = [...pendingBackground.values()]
            if (!completions.length) return
            // 只更新仍存在的同一会话与轮次；清除、过期或裁剪后不重建旧记录。
            const previous = await conversationStore.get(key)
            if (!previous || previous.sessionId !== sessionId) {
              pendingBackground.clear()
              return
            }
            const patches = new Map<string, UnknownRecord>()
            const turns = previous.turns.map(value => {
              const turn = record(value)
              if (turn.id !== turnId) return turn
              const toolChain = list(turn.toolChain).map(value => {
                const trace = record(value)
                const completion = completions.find(item => item.toolCallId === trace.id && item.taskId === record(trace.metadata).taskId)
                if (!completion) return trace
                const updated = completedToolTrace(trace, completion)
                patches.set(completion.taskId, updated)
                return updated
              })
              return { ...turn, toolChain }
            })
            if (patches.size) {
              const history = previous.history.map(value => {
                const message = record(value)
                const metadata = record(message.metadata)
                const patch = metadata.turnId === turnId && message.role === "tool" ? patches.get(text(metadata.taskId)) : undefined
                return patch ? { ...message, content: toolHistoryResult(patch) } : value
              })
              const protocolState = { ...previous.protocolState, responses: {}, toolResultsVersion: number(previous.protocolState.toolResultsVersion) + 1 }
              await conversationStore.save({ id: key, ...previous, history, turns, protocolState })
              runtime.conversations.set(key, { ...previous, history, turns, protocolState, lastSeen: Date.now() })
            }
            for (const completion of completions) pendingBackground.delete(completion.taskId)
          })
          runtime.retainConversationWrite(key, turnId, null)
          return
        } catch (error) {
          runtime.conversations.delete(key)
          hostRuntime.logger?.warn?.("[yui-chat] 后台工具结果写回 SQLite 失败", errorSummary(error))
          // 短暂故障最多重试两次，之后保留到同一会话下次读取时恢复。
          if (attempt >= 2) {
            runtime.retainConversationWrite(key, turnId, persistBackgroundCompletions)
            throw error
          }
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
        }
      }
    }
    const onBackgroundToolComplete = async (completion: BackgroundToolCompletion): Promise<void> => {
      if (options.transient === true) return
      pendingBackground.set(completion.taskId, completion)
      await persistBackgroundCompletions()
    }
    if (trace && typeof trace === "object") (trace as unknown as UnknownRecord).sessionId = sessionId
    const artifacts = artifactStore.open({
      key,
      sessionId,
      userId: text(record(event).user_id),
      groupId: text(record(event).group_id),
      maxScopes: number(chat.maxConversationScopes, 1000),
      isCurrent: () => runtime.conversationVersionCurrent(conversationVersion),
    })

    await recentContextStore.buildPromptWithHistory(event)
    if (media && mediaEnabled) {
      // 明确引用/本次附件始终优先；跟进本轮图片时先读取会话里的受管缓存引用。
      const canRecall = !media.quote && !media.attachments.some(item => item.kind === "image" && item.visionEligible !== false)
      const previousUser = [...history].reverse().map(record).find(item => item.role === "user")
      // 引用图片是请求级资源，不应从旧会话元数据恢复；兼容清理历史中
      // 可能已经存在的旧引用条目，后续只回看可受管缓存的普通图片。
      const previousImages = list(record(previousUser?.metadata).imageReferences)
        .map(record)
        .filter(item => item.source !== "quote")
      if (canRecall && !recentContextStore.referencedUsers(event, prompt).length && conversationImageFollowup(prompt) && previousImages.length) {
        media.attachments.push(...previousImages.filter(item => /^[a-f0-9]{64}$/.test(text(item.cacheKey))).map(item => ({
          kind: "image" as const, cacheKey: text(item.cacheKey), source: text(item.source),
          messageId: item.messageId, sender: record(item.sender), imageNumber: item.imageNumber, fromHistory: true, visionEligible: true,
        })))
      }
      const recallMode = recentImageRecallMode(media, prompt)
      if (recallMode !== "none") {
        const selection = recallMode === "adjacent"
          ? recentContextStore.selectAdjacentImages(event)
          : recentContextStore.selectRecentImages(event, prompt)
        if (selection.diagnostic) media.diagnostics.push(selection.diagnostic)
        for (const recentImage of selection.images) {
          const refreshed = await refreshRecentImage(event, recentImage)
          if (!refreshed) {
            media.diagnostics.push(`未能重新读取 ${recentImage.name} 的目标图片，请引用或重发原图；不采用其他图片。`)
            continue
          }
          media.attachments.push({
            kind: "image", url: refreshed, source: recentImage.source, messageId: recentImage.messageId,
            sender: { userId: recentImage.userId, name: recentImage.name }, visionEligible: true,
          })
        }
      }
      media = await prepareMediaForVision(media, config) as ResolvedMediaContext
    } else if (media) {
      media.attachments = media.attachments.map(item => ({ ...item, visionEligible: false }))
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
      artifacts,
      onBackgroundToolComplete,
      onToolRoundComplete: (progress: UnknownRecord) => {
        observedToolChain.push(...list(progress.toolChain).map(record))
        toolProgress = progress
      },
    })
    const stepResults = [record(result)]
    let taskError: ConversationTaskError | undefined
    if (result.status === "error") {
      const resultError = record(result.error)
      const message = text(resultError.message || "unknown error")
      const diagnostic = errorSummary(result.cause || result.error || message)
      modelLogStore.finishTrace(trace, { status: "error", error: result.cause || result.error || message, metadata: { step: result.stepId, errorDetails: record(resultError.details) } })
      conversationLog.failed(config, {
        scope: scopeFor(event),
        step: result.stepId,
        channel: result.channel,
        adapter: result.adapter,
        attempts: list(result.attempts).length,
        error: diagnostic,
      })
      hostRuntime.logger?.error?.(`[yui-chat] task ${text(result.stepId)} failed: ${diagnostic}`)
      taskError = new ConversationTaskError(`Task ${text(result.stepId)} failed: ${message}`, result.cause, {
        name: text(step.task),
        failedStep: text(result.stepId),
        steps: publicStepResult(stepResults),
      })
      if (!observedToolChain.length) throw taskError
    }

    const successfulSteps = stepResults.filter(item => item.status === "ok")
    const final = taskError
      ? { ...result, ...toolProgress, usage: toolProgress.usage || emptyUsage(), modelCalls: toolProgress.modelCalls || [], requiresFinalReply: false }
      : [...successfulSteps].reverse().find(item => text(item.mode) === "final" && text(item.text)) || successfulSteps.at(-1) || {}
    const finalRequiresFinalReply = final.requiresFinalReply !== false
    // 回合观察保留失败渠道已执行的事实；成功步骤中的托管工具记录也继续保留。
    const finalStepTools = list(final.toolChain).map(record)
    const finalStepToolSet = new Set(finalStepTools)
    const finalToolChain = [...observedToolChain.filter(trace => !finalStepToolSet.has(trace)), ...finalStepTools]
    const errorSteps = stepResults.filter(item => item.status === "error")
    const deliveredReplyText = final.replyDelivered === true ? normalizeResponseText(final.deliveredReplyText) : ""
    const rawFinalText = taskError ? "" : deliveredReplyText || text(final.text) || (finalRequiresFinalReply
      ? errorSteps.length
        ? `默认任务没有可用回复：${errorSteps.map(item => `${text(item.stepId)} ${text(record(item.error).message)}`).join("；")}`
        : finalToolChain.length
          ? final.toolLimitReached ? "工具调用已达到本轮上限，但模型未生成最终说明。" : "工具已执行，但模型未生成最终说明。"
          : "模型没有返回文本。"
      : "")
    const finalText = normalizeResponseText(rawFinalText)

    if (!taskError) conversationLog.completed(config, {
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
    if (!taskError) modelLogStore.finishTrace(trace, {
      status: isEmptyResponse(rawFinalText) ? "silent" : "ok",
      response: finalText,
      metadata: {
        ...traceMetadata(final),
        steps: stepResults.map(item => ({ stepId: item.stepId, status: item.status })),
      },
    })

    let historySaved = true
    const resultPayload = (): UnknownRecord => ({
      id: final.id,
      channel: text(final.channel || firstChannel.id),
      adapter: final.adapter,
      source: text(options.source),
      conversationKey: key,
      sessionId,
      ...(historySaved ? {} : { historySaved: false }),
      prompt,
      media: summarizeMediaForResult(media),
      text: deliveredReplyText ? "" : finalText,
      ...(deliveredReplyText ? { replyDelivered: true, deliveredReplyText } : {}),
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

    if (options.transient === true) {
      if (taskError) throw taskError
      return resultPayload()
    }

    if (!isEmptyResponse(rawFinalText) || finalToolChain.length) {
      const maxHistoryMessages = Math.max(2, number(chat.maxHistoryMessages, 12))
      const turn: UnknownRecord = {
        id: turnId,
        responseId: text(final.id),
        at: nowIso(),
        channel: text(final.channel || firstChannel.id),
        adapter: text(final.adapter),
        usage: final.usage || emptyUsage(),
        modelCalls: final.modelCalls || [],
        toolChain: finalToolChain,
      }
      await runtime.enqueueConversationMutation(async () => {
        if (!runtime.conversationVersionCurrent(conversationVersion)) return
        try {
          // 缓存可能因并发写入失败或淘汰而缺失，必须基于 SQLite 已提交历史追加。
          const previousValue = runtime.conversations.get(key) ?? await conversationStore.get(key)
          if (!runtime.conversationVersionCurrent(conversationVersion)) return
          const previous = record(previousValue)
          const baseHistory = Array.isArray(previousValue) ? previousValue : list(previous.history)
          const savedToolChain = finalToolChain.map(trace => {
            const completion = pendingBackground.get(text(record(trace.metadata).taskId))
            return completion ? completedToolTrace(trace, completion) : trace
          })
          const nextHistory = trimConversationHistory([
            ...baseHistory,
            { role: "user", content: text(final.historyUserContent) || prompt, metadata: { turnId, messageId: text(record(event).message_id), requesterId: text(record(event).user_id), imageReferences: list(final.imageReferences) } },
            ...toolHistoryMessages(savedToolChain, turnId),
            ...(finalText ? [{ role: "assistant", content: finalText, metadata: { turnId } }] : []),
          ], maxHistoryMessages)
          const turns = [...list(previous.turns), { ...turn, toolChain: savedToolChain }].slice(-Math.max(1, Math.floor(maxHistoryMessages / 2)))
          const usage = emptyUsage()
          for (const item of turns) addUsage(usage, record(item).usage)
          let protocolState = updatedProtocolState(previous.protocolState, final.responseState, toolResultsVersion)
          if (savedToolChain.length) {
            // 已被最终模型请求消费的普通工具继续续接；直投与后台结果走本地回放。
            const needsLocalReplay = !finalRequiresFinalReply || savedToolChain.some(trace => record(trace.metadata).background === true)
            protocolState = { ...protocolState, ...(needsLocalReplay ? { responses: {} } : {}), toolResultsVersion: number(protocolState.toolResultsVersion) + 1 }
          }
          const toolCalls = turns.reduce((sum: number, item) => sum + list(record(item).toolChain).length, 0)
          await conversationStore.save({ id: key, sessionId, history: nextHistory, turns, usage, toolCalls, protocolState })
          runtime.conversations.set(key, { sessionId, history: nextHistory, turns, usage, toolCalls, protocolState, lastSeen: Date.now() })
          historyCommitted = true
        } catch (error) {
          runtime.conversations.delete(key)
          historySaved = false
          hostRuntime.logger?.warn?.("[yui-chat] 会话读取或写入 SQLite 失败，本轮历史未保存", error)
        }
      })
      await persistBackgroundCompletions().catch(error => {
        hostRuntime.logger?.warn?.("[yui-chat] 后台工具结果等待下次会话读取补写，真实结果仍可查询调用日志", errorSummary(error))
      })
    } else {
      await runtime.enqueueConversationMutation(async () => {
        if (!runtime.conversationVersionCurrent(conversationVersion)) return
        try {
          const previousValue = runtime.conversations.get(key) ?? await conversationStore.get(key)
          if (!runtime.conversationVersionCurrent(conversationVersion)) return
          const previous = record(previousValue)
          const currentHistory = Array.isArray(previousValue) ? previousValue : list(previous.history)
          const protocolState = updatedProtocolState(previous.protocolState, final.responseState, toolResultsVersion)
          const next = { ...previous, sessionId, history: currentHistory, protocolState, lastSeen: Date.now() }
          await conversationStore.save({
            id: key,
            sessionId,
            history: currentHistory,
            turns: list(previous.turns),
            usage: record(previous.usage),
            toolCalls: previous.toolCalls,
            protocolState,
          })
          runtime.conversations.set(key, next)
        } catch (error) {
          runtime.conversations.delete(key)
          historySaved = false
          hostRuntime.logger?.warn?.("[yui-chat] 读取或刷新 SQLite 会话活跃时间失败", error)
        }
      })
    }
    if (taskError) throw taskError
    return resultPayload()
  } finally {
    runtime.releaseConversationVersion(conversationVersion)
  }
}
