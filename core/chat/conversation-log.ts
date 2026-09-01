import { createScopedLog } from "../shared/scoped-log.js"
import type { UnknownRecord } from "../message/types.js"

type LogConfig = unknown
type ToolLogOptions = UnknownRecord & {
  round?: unknown
  name?: unknown
  status?: unknown
  durationMs?: unknown
  resultChars?: unknown
  error?: unknown
}

const output = createScopedLog("Conversation")

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function number(value: unknown): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : 0
}

function flag(value: unknown): string {
  return value ? "yes" : "no"
}

/** 对话链路日志只负责结构化摘要，不保存正文或凭证；详细拓扑由持久化观测层负责。 */
export const conversationLog = Object.freeze({
  started(config: LogConfig, options: UnknownRecord): void {
    output.info(config, `开始 scope=${text(options.scope)} source=${text(options.source)} promptChars=${number(options.promptChars)}`)
  },
  modelRequest(config: LogConfig, options: UnknownRecord): void {
    output.debug(config, `模型请求 channel=${text(options.channel)} adapter=${text(options.adapter)} messages=${number(options.messages)} tools=${number(options.tools)} maxTokens=${number(options.maxTokens)} timeout=${number(options.timeoutMs)}ms stream=${flag(options.stream)}${options.phase ? ` phase=${text(options.phase)}` : ""}`)
  },
  /** 只在真正触发压缩时输出：未超窗口的正常请求不该产生噪音。 */
  promptCompressed(config: LogConfig, options: UnknownRecord): void {
    const dropped = number(options.unitsDropped) ? ` droppedUnits=${number(options.unitsDropped)} droppedMessages=${number(options.messagesDropped)}` : ""
    output.warn(config, `上下文压缩 limit=${number(options.limit)} before=${number(options.before)} after=${number(options.after)} toolPayloads=${number(options.toolPayloadsCompressed)}${dropped}${options.phase ? ` phase=${text(options.phase)}` : ""}`)
  },
  toolCompleted(config: LogConfig, options: ToolLogOptions): void {
    const status = text(options.status)
    const execution = [
      options.operationId ? `operation=${text(options.operationId)}` : "",
      options.operationFamily ? `family=${text(options.operationFamily)}` : "",
      options.effect ? `effect=${text(options.effect)}` : "",
      options.repeatPolicy ? `repeat=${text(options.repeatPolicy)}` : "",
      options.retryPolicy ? `retryPolicy=${text(options.retryPolicy)}` : "",
      `dispatched=${flag(options.dispatched)}`,
      options.decision ? `decision=${text(options.decision)}` : "",
      options.guardCode ? `guard=${text(options.guardCode)}` : "",
      `requested=${number(options.requestedCount)}`,
      `executed=${number(options.executedCount)}`,
      `completed=${number(options.completedCount)}`,
      `remaining=${number(options.remainingCount)}`,
      `attempt=${number(options.attempt)}`,
      `retry=${options.retryAllowed === false ? "no" : "yes"}`,
    ].filter(Boolean).join(" ")
    const chain = Array.isArray(options.contentTypes) && options.contentTypes.length ? ` chain=${options.contentTypes.map(text).join(",")} media=${number(options.mediaPartCount)}` : ""
    const receipt = options.receiptStatus ? ` receipt=${text(options.receiptStatus)}` : ""
    const message = `工具 round=${number(options.round)} name=${text(options.name)} status=${status} delivery=${text(options.delivery || "silent")} requiresFinalReply=${flag(options.requiresFinalReply !== false)}${options.deduplicated ? " deduplicated=yes" : ""}${chain}${receipt} ${execution} duration=${number(options.durationMs)}ms resultChars=${number(options.resultChars)}${options.error ? ` error=${text(options.error)}` : ""}`
    if (["error", "failed", "denied", "ambiguous", "canceled", "blocked"].includes(status)) output.warn(config, message)
    else output.info(config, message)
  },
  completed(config: LogConfig, options: UnknownRecord): void {
    const finalization = options.toolFinalizationError ? "failed" : options.toolFinalizationAttempted ? "ok" : "not-needed"
    const execution = record(options.execution)
    const executionSummary = execution.finalizationReason || options.toolFinalizationReason ? ` execution=${text(execution.phase || "finalizing")}:${text(execution.finalizationReason || options.toolFinalizationReason)}` : ""
    const mediaSummary = options.mediaDirectOutputDetected || options.mediaCorrectionAttempted ? ` mediaDirect=${flag(options.mediaDirectOutputDetected)} mediaCorrection=${text(options.mediaCorrectionStatus || "not-needed")}` : ""
    const usage = record(options.usage)
    const chainSummary = options.mediaCandidateSeen ? ` mediaResources=seen` : ""
    output.info(config, `完成 scope=${text(options.scope)} channel=${text(options.channel)} duration=${number(options.durationMs)}ms tools=${number(options.tools)} requiresFinalReply=${flag(options.requiresFinalReply !== false)} toolLimit=${flag(options.toolLimitReached)} deduplicated=${flag(options.toolDeduplicated)} finalization=${finalization}${executionSummary}${mediaSummary}${chainSummary} tokens=${number(usage.total)} input=${number(usage.input)} output=${number(usage.output)}`)
  },
  failed(config: LogConfig, options: UnknownRecord): void {
    output.error(config, `失败 scope=${text(options.scope)} step=${text(options.step)} error=${text(options.error)}`)
  },
})

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}
