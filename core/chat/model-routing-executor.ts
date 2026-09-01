import { providerResolver } from "../../models/routing/provider-resolver.js"
import type { UnknownRecord } from "../message/types.js"
import { channelAttemptError, errorPayload, nowIso, stepId } from "./chat-support.js"
import { hostRuntime } from "../runtime/host-runtime.js"

export interface ModelRoutingRuntime {
  runModelStepWithChannel(options: UnknownRecord): Promise<UnknownRecord>
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function optionalText(value: unknown): string | undefined {
  const result = text(value).trim()
  return result || undefined
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function errorMessage(error: unknown): string {
  return text(record(error).message || error || "unknown error")
}

function attemptsOf(error: unknown): UnknownRecord[] {
  const attempts = record(error).attempts
  return Array.isArray(attempts) ? attempts.map(record) : []
}

class ModelRoutingError extends Error {
  readonly attempts: UnknownRecord[]

  constructor(message: string, cause: unknown, attempts: UnknownRecord[]) {
    super(message, { cause })
    this.name = "ModelRoutingError"
    this.attempts = attempts
  }
}

/**
 * 执行一个模型步骤的渠道选择与 fallback；真正的模型请求由单渠道执行器完成。
 * 这里不再复制工具循环，只负责把候选渠道、尝试记录和失败边界串起来。
 */
export async function runModelStep(
  options: unknown = {},
  runtime: ModelRoutingRuntime,
): Promise<UnknownRecord> {
  const opts = record(options)
  const config = record(opts.config)
  const chat = record(config.chat)
  const step = record(opts.step)
  const taskName = text(step.task) || text(chat.defaultTask)
  const channels = providerResolver.resolveCandidateChannels({
    taskName,
    channelId: optionalText(opts.channelId),
    config,
  })
  const attempts: UnknownRecord[] = []
  let lastError: unknown = null
  const taskConfig = record(record(config.modelTasks)[taskName])
  const selectionStrategy = text(taskConfig.selectionStrategy)

  for (const [channelIndex, channel] of channels.entries()) {
    try {
      const result = await runtime.runModelStepWithChannel({
        ...opts,
        config,
        step,
        channel,
        availableChannels: channels,
        channelAttempt: channelIndex + 1,
        selectionStrategy,
      })
      return {
        ...result,
        attempts: [
          ...attempts,
          {
            channel: channel.id,
            adapter: text(result.adapter),
            provider: text(result.provider),
            status: "ok",
          },
        ],
      }
    } catch (error) {
      lastError = error
      attempts.push({ ...channelAttemptError(channel, error), status: "error" })
      if (text(taskConfig.selectionStrategy) !== "fallback") break
      hostRuntime.logger?.warn?.(`[yui-chat] 任务 ${taskName} 渠道 ${channel.id} 失败，尝试 fallback`, error)
    }
  }

  const detail = errorMessage(lastError)
  const summary = /timeout|超时/i.test(detail)
    ? `任务 ${taskName} 模型请求超时`
    : `任务 ${taskName} 的模型渠道调用失败`
  throw new ModelRoutingError(`${summary}：${detail}`, lastError, attempts)
}

/** 为多步骤编排补充耗时、状态和可序列化的失败摘要。 */
export async function runObservedStep(
  options: unknown = {},
  runtime: ModelRoutingRuntime,
): Promise<UnknownRecord> {
  const opts = record(options)
  const startedAt = nowIso()
  const started = Date.now()
  try {
    const result = await runModelStep(opts, runtime)
    return {
      ...result,
      status: "ok",
      startedAt,
      endedAt: nowIso(),
      durationMs: Date.now() - started,
    }
  } catch (error) {
    const step = record(opts.step)
    return {
      id: null,
      stepId: stepId(step, number(opts.index)),
      mode: text(step.mode) || "final",
      channel: optionalText(opts.channelId) || "",
      adapter: "",
      text: "",
      toolRounds: 0,
      status: "error",
      error: errorPayload(error),
      attempts: attemptsOf(error),
      cause: error,
      startedAt,
      endedAt: nowIso(),
      durationMs: Date.now() - started,
    }
  }
}
