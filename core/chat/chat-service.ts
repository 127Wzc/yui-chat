import { isEmptyResponse } from "./response-pipeline.js"
import { ConversationState, type ConversationEntry, type ConversationVersion } from "./conversation-state.js"
import { modelLogStore } from "../observability/model-log.js"
import type { UnknownRecord } from "../message/types.js"
import { executeToolRound as runToolRound } from "./tool-round-executor.js"
import { runModelStepWithChannelInternal as runModelStepWithChannelInternalTs } from "./model-step-executor.js"
import { runModelStep as runModelStepTs, runObservedStep as runObservedStepTs } from "./model-routing-executor.js"
import { runSubAgent as runSubAgentTs, type SubAgentRuntime } from "./subagent-executor.js"
import { sendConversation as sendConversationTs, type ConversationRequestRuntime } from "./conversation-request-executor.js"

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

/**
 * Chat Service 的公开门面。
 *
 * 具体模型步骤、工具轮次、子代理和请求生命周期已经分别下沉到 TS 执行器；
 * 这里仅组合会话状态并提供兼容宿主调用的稳定方法，便于后续继续替换内部模块。
 */
export class ChatService {
  private readonly conversationState = new ConversationState()
  private readonly subAgentRuns: UnknownRecord[] = []
  private activeSubAgentRuns = 0

  get conversations(): Map<string, unknown> {
    return this.conversationState.conversations as Map<string, unknown>
  }

  enqueueConversationMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.conversationState.enqueue(operation)
  }

  captureConversationVersion(event: unknown, key: unknown): ConversationVersion {
    return this.conversationState.captureVersion(event, text(key))
  }

  conversationVersionCurrent(version: unknown): boolean {
    return this.conversationState.isCurrent(version as ConversationVersion | null)
  }

  releaseConversationVersion(version: unknown): void {
    this.conversationState.releaseVersion(version as ConversationVersion | null)
  }

  prune(config: unknown): void {
    this.conversationState.prune(config)
  }

  waitForConversationMutations(): Promise<void> {
    return this.conversationState.waitForMutations()
  }

  async getHistory(key: unknown, version: unknown = null): Promise<unknown[]> {
    return this.conversationState.getHistory(text(key), version as ConversationVersion | null)
  }

  async getConversation(key: unknown, version: unknown = null): Promise<ConversationEntry> {
    return this.conversationState.getConversation(text(key), version as ConversationVersion | null)
  }

  conversationKey(event: unknown, channelId: unknown): string {
    return this.conversationState.conversationKey(event, text(channelId))
  }

  scopeMatches(parsed: unknown, event: unknown, userId?: unknown): boolean {
    return this.conversationState.scopeMatches(parsed as Parameters<ConversationState["scopeMatches"]>[0], event, userId)
  }

  clear(event: unknown, options: unknown = {}): Promise<number> {
    return this.conversationState.clear(event, options)
  }

  clearAll(): Promise<number> {
    return this.conversationState.clearAll()
  }

  clearByKeys(keys: unknown[] = []): Promise<number> {
    return this.conversationState.clearByKeys(keys)
  }

  stats(): UnknownRecord {
    return {
      conversations: this.conversations.size,
      activeSubAgents: this.activeSubAgentRuns,
    }
  }

  changeActiveSubAgentRuns(delta: unknown): void {
    this.activeSubAgentRuns = Math.max(0, this.activeSubAgentRuns + number(delta))
  }

  recordSubAgentRun(entry: unknown): void {
    this.subAgentRuns.unshift(record(entry))
    if (this.subAgentRuns.length > 50) this.subAgentRuns.length = 50
  }

  listSubAgentRuns(limit = 20): UnknownRecord[] {
    return this.subAgentRuns.slice(0, Math.max(0, number(limit, 20)))
  }

  listConversations(options: unknown = {}): UnknownRecord[] {
    return this.conversationState.list(options)
  }

  async executeToolRound(options: unknown = {}): Promise<unknown> {
    return runToolRound(options as Parameters<typeof runToolRound>[0])
  }

  /** 单渠道执行器的 trace 兜底；上层请求已有 trace 时不重复创建终态。 */
  async runModelStepWithChannel(options: unknown = {}): Promise<UnknownRecord> {
    const input = record(options)
    const ownsTrace = !input.trace
    const trace = input.trace || modelLogStore.createTrace({
      event: input.e,
      source: text(input.source) || "chat",
      purpose: text(input.purpose) || (input.source === "subagent" ? "subagent" : "chat"),
      prompt: text(input.prompt),
      metadata: { transient: true, step: text(record(input.step).id || record(input.step).task) },
    })
    try {
      // 由外层创建的 trace 必须传入单渠道执行器；否则每次模型调用会各自创建孤立 run，
      // 工具事件拿不到 run_id/model_call_id，日志详情也无法还原完整工具链路。
      const result = await runModelStepWithChannelInternalTs({
        ...input,
        trace,
      } as Parameters<typeof runModelStepWithChannelInternalTs>[0])
      if (ownsTrace) {
        const execution = record(result.execution)
        const agentTurn = record(result.agentTurn)
        modelLogStore.finishTrace(trace, {
          status: isEmptyResponse(result.text) ? "silent" : "ok",
          response: result.text,
          metadata: {
            requiresFinalReply: result.requiresFinalReply,
            toolLimitReached: Boolean(result.toolLimitReached),
            toolFinalizationAttempted: Boolean(result.toolFinalizationAttempted),
            toolFinalization: result.toolFinalizationError ? "failed" : result.toolFinalizationAttempted ? "ok" : "not-needed",
            toolDeduplicated: Boolean(result.toolDeduplicated),
            toolFinalizationReason: result.toolFinalizationReason || "",
            mediaCorrectionAttempted: Boolean(result.mediaCorrectionAttempted),
            mediaCorrectionStatus: result.mediaCorrectionStatus || "not-needed",
            mediaDirectOutputDetected: Boolean(result.mediaDirectOutputDetected),
            mediaDeliveryRequired: Boolean(result.mediaDeliveryRequired),
            mediaCandidateSeen: Boolean(result.mediaCandidateSeen),
            searchDeliveryRequired: Boolean(result.searchDeliveryRequired),
            searchDeliveryAttempted: Boolean(result.searchDeliveryAttempted),
            searchDeliveryStatus: result.searchDeliveryStatus || "not-needed",
            execution: execution.phase ? {
              turnCount: execution.turnCount,
              toolCallCount: execution.toolCallCount,
              sideEffectCount: execution.sideEffectCount,
              guardBlockStreak: execution.guardBlockStreak,
              noProgressStreak: execution.noProgressStreak,
              phase: execution.phase,
              finalizationReason: execution.finalizationReason,
            } : {},
            agentTurn: agentTurn.phase ? {
              phase: agentTurn.phase,
              lastStopReason: agentTurn.lastStopReason,
              finalReplyRequired: agentTurn.finalReplyRequired === true,
              emptyFinalRecoveryCount: Number(agentTurn.emptyFinalRecoveryCount || 0),
              finalizationReason: agentTurn.finalizationReason || "",
            } : {},
          },
        })
      }
      return result
    } catch (error) {
      if (ownsTrace) modelLogStore.finishTrace(trace, { status: "error", error })
      throw error
    }
  }

  runModelStepWithChannelInternal(options: unknown = {}): Promise<UnknownRecord> {
    return runModelStepWithChannelInternalTs(options as Parameters<typeof runModelStepWithChannelInternalTs>[0])
  }

  runSubAgent(options: unknown = {}): Promise<UnknownRecord> {
    const runtime: SubAgentRuntime = {
      getActiveSubAgentRuns: () => this.activeSubAgentRuns,
      changeActiveSubAgentRuns: delta => this.changeActiveSubAgentRuns(delta),
      recordSubAgentRun: entry => this.recordSubAgentRun(entry),
      runModelStepWithChannel: stepOptions => this.runModelStepWithChannel(stepOptions),
    }
    return runSubAgentTs(options, runtime)
  }

  runModelStep(options: unknown = {}): Promise<UnknownRecord> {
    return runModelStepTs(options, {
      runModelStepWithChannel: stepOptions => this.runModelStepWithChannel(stepOptions),
    })
  }

  runObservedStep(options: unknown = {}): Promise<UnknownRecord> {
    return runObservedStepTs(options, {
      runModelStepWithChannel: stepOptions => this.runModelStepWithChannel(stepOptions),
    })
  }

  send(event: unknown, prompt: unknown, options: unknown = {}): Promise<UnknownRecord> {
    const runtime: ConversationRequestRuntime = {
      conversations: this.conversations,
      enqueueConversationMutation: operation => this.enqueueConversationMutation(operation),
      captureConversationVersion: (value, key) => this.captureConversationVersion(value, key),
      conversationVersionCurrent: version => this.conversationVersionCurrent(version),
      releaseConversationVersion: version => this.releaseConversationVersion(version),
      prune: config => this.prune(config),
      waitForConversationMutations: () => this.waitForConversationMutations(),
      getHistory: (key, version) => this.getHistory(key, version),
      getConversation: (key, version) => this.getConversation(key, version),
      conversationKey: (value, channelId) => this.conversationKey(value, channelId),
      runObservedStep: value => this.runObservedStep(value),
    }
    return sendConversationTs(event, prompt, options, runtime)
  }
}

export const chatService = new ChatService()
