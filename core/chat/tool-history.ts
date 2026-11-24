import { randomUUID } from "node:crypto"
import type { UnknownRecord } from "../message/types.js"
import { redactErrorText } from "../shared/error-details.js"
import { serializeForModel } from "../message-chain/serialize.js"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

/** 持久化与回放只保留有界、脱敏的执行事实，不保留协议推理项或内联媒体。 */
export function toolHistoryText(value: unknown): string {
  return redactErrorText(serializeForModel(value ?? ""), 16000, true)
}

function toolHistoryArguments(value: unknown): string {
  const encoded = toolHistoryText(value)
  try { return JSON.stringify(JSON.parse(encoded)) }
  catch { return JSON.stringify({ omitted: "参数超出历史记录上限", preview: encoded.slice(0, 1000) }) }
}

export function toolHistoryResult(trace: UnknownRecord): string {
  return JSON.stringify({
    status: trace.status,
    result: toolHistoryText(trace.result ?? trace.resultPreview ?? ""),
    ...(trace.executedCount !== undefined ? { executedCount: trace.executedCount, remainingCount: trace.remainingCount, retryAllowed: trace.retryAllowed } : {}),
    ...(trace.error ? { error: toolHistoryText(trace.error) } : {}),
    ...(record(trace.metadata).backgroundStatus ? { backgroundStatus: record(trace.metadata).backgroundStatus } : {}),
  })
}

/** 历史调用使用独立 ID，避免供应商或扩展复用 call ID 后配对到另一轮。 */
export function toolHistoryMessages(traces: UnknownRecord[], turnId: string): UnknownRecord[] {
  return traces.filter(trace => trace.id && trace.name && Object.hasOwn(trace, "result")).flatMap(trace => {
    const id = `call_${randomUUID().replace(/-/g, "")}`
    const metadata = { turnId, toolCallId: String(trace.id), taskId: String(record(trace.metadata).taskId || "") }
    return [
      { role: "assistant", content: "", metadata, tool_calls: [{ id, type: "function", function: { name: trace.name, arguments: toolHistoryArguments(trace.arguments) } }] },
      { role: "tool", tool_call_id: id, name: trace.name, content: toolHistoryResult(trace), metadata },
    ]
  })
}

/** 按用户轮次裁剪，不能按消息条数截断 assistant/tool 配对。 */
export function trimConversationHistory(messages: unknown[], maxHistoryMessages: number): unknown[] {
  const starts = messages.flatMap((message, index) => record(message).role === "user" ? [index] : [])
  const maxTurns = Math.max(1, Math.floor(maxHistoryMessages / 2))
  return starts.length > maxTurns ? messages.slice(starts[starts.length - maxTurns]) : messages
}

export interface BackgroundToolCompletion extends UnknownRecord {
  toolCallId: string
  taskId: string
  status: string
  result: string
  error: string
  endedAt: number
  startedAt: number
  executedCount: number
  completedCount: number
  remainingCount: number
  retryAllowed: boolean
  metadata: UnknownRecord
}

export function completedToolTrace(trace: UnknownRecord, completion: BackgroundToolCompletion): UnknownRecord {
  const resultText = toolHistoryText(completion.result)
  // 回执中的绝对进度由执行器计算，重复补写只替换快照，不累计次数。
  return {
    ...trace,
    status: completion.status,
    result: resultText,
    resultPreview: resultText.slice(0, 300),
    resultChars: completion.result.length,
    error: toolHistoryText(completion.error),
    durationMs: Math.max(0, completion.endedAt - completion.startedAt),
    executedCount: completion.executedCount,
    completedCount: completion.completedCount,
    remainingCount: completion.remainingCount,
    retryAllowed: completion.retryAllowed,
    metadata: { ...record(trace.metadata), ...completion.metadata, taskId: completion.taskId, backgroundCompletedAt: completion.endedAt },
  }
}
