import { providerResolver } from "../../models/routing/provider-resolver.js"
import { modelLogStore } from "../observability/model-log.js"
import type { UnknownRecord } from "../message/types.js"
import { nowIso } from "./chat-support.js"

export interface SubAgentRuntime {
  getActiveSubAgentRuns(): number
  changeActiveSubAgentRuns(delta: number): void
  recordSubAgentRun(entry: UnknownRecord): void
  runModelStepWithChannel(options: UnknownRecord): Promise<UnknownRecord>
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
  return text(record(error).message || error || "执行失败")
}

/** 子代理运行边界：独立历史、独立工具白名单和可取消的运行时生命周期。 */
export async function runSubAgent(
  options: unknown = {},
  runtime: SubAgentRuntime,
): Promise<UnknownRecord> {
  const opts = record(options)
  const config = record(opts.config)
  const sub = record(config.subAgent)
  const event = opts.e
  const taskName = sub.task && record(config.modelTasks)[text(sub.task)]
    ? text(sub.task)
    : text(record(config.chat).defaultTask)
  const eventRecord = record(event)
  const caller = eventRecord.isGroup === true ? `群 ${text(eventRecord.group_id)}` : `私聊 ${text(eventRecord.user_id || "-")}`
  const startedAt = nowIso()
  const started = Date.now()
  const task = text(opts.task)
  const taskPreview = task.slice(0, 120)
  const depth = number(opts.depth)
  const maxConcurrency = Math.max(1, Math.min(number(sub.maxConcurrency, 3), 8))
  if (runtime.getActiveSubAgentRuns() >= maxConcurrency) {
    runtime.recordSubAgentRun({
      task: taskPreview,
      caller,
      channel: "",
      toolRounds: 0,
      tools: [],
      chars: 0,
      depth: depth + 1,
      ok: false,
      error: "全局并发已满",
      startedAt,
      durationMs: 0,
    })
    return { text: "子代理资源繁忙，请稍后重试。", toolRounds: 0, busy: true }
  }

  runtime.changeActiveSubAgentRuns(1)

  const maxDurationMs = Math.max(10000, Math.min(number(sub.maxDurationMs, 120000), 600000))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`子代理执行超过 ${maxDurationMs}ms`)), maxDurationMs)
  timeout.unref?.()
  let channel: UnknownRecord | null = null
  let childTrace: unknown = null
  try {
    childTrace = modelLogStore.createTrace({
      event,
      source: "subagent",
      purpose: "subagent",
      parentId: text(record(opts.trace).id),
      prompt: task,
      metadata: { depth: depth + 1 },
    })
    const channels = providerResolver.resolveCandidateChannels({ taskName, channelId: undefined, config })
    channel = record(channels[0])
    if (!channel.id) throw new Error("无可用模型渠道")
    const result = await runtime.runModelStepWithChannel({
      e: event,
      prompt: task,
      config,
      history: [],
      step: { id: "subagent", task: taskName, mode: "final" },
      channel,
      prior: [],
      media: null,
      source: "subagent",
      purpose: "subagent",
      trace: childTrace,
      parentToolId: text(opts.parentToolId),
      extraSystemPrompt: text(sub.systemPrompt),
      agentContext: {
        depth: depth + 1,
        allowedTools: list(sub.allowedTools).map(text),
        maxToolRounds: Math.max(0, number(sub.maxToolRounds)),
        maxToolCallsPerRound: Math.max(1, Math.min(number(sub.maxToolCallsPerRound, 4), 8)),
        signal: controller.signal,
      },
    })
    const resultText = text(result.text)
    modelLogStore.finishTrace(childTrace, { status: resultText ? "ok" : "silent", response: resultText, metadata: { depth: depth + 1 } })
    runtime.recordSubAgentRun({
      task: taskPreview,
      caller,
      channel: text(result.channel || channel.id),
      toolRounds: number(result.toolRounds),
      tools: list(result.toolsUsed),
      chars: resultText.length,
      depth: depth + 1,
      ok: Boolean(resultText),
      startedAt,
      durationMs: Date.now() - started,
    })
    return { text: resultText, toolRounds: number(result.toolRounds), channel: result.channel }
  } catch (error) {
    const failure = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error
    runtime.recordSubAgentRun({
      task: taskPreview,
      caller,
      channel: text(channel?.id),
      toolRounds: 0,
      tools: [],
      chars: 0,
      depth: depth + 1,
      ok: false,
      error: errorMessage(failure).slice(0, 200),
      startedAt,
      durationMs: Date.now() - started,
    })
    modelLogStore.finishTrace(childTrace, { status: "error", error: errorMessage(failure), metadata: { depth: depth + 1 } })
    throw failure
  } finally {
    clearTimeout(timeout)
    runtime.changeActiveSubAgentRuns(-1)
  }
}
