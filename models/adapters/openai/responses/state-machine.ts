import { responsesAllowsStateRecovery, type ResponsesStateMode } from "../../../configuration/responses-state.js"
import type { ModelRequest, ModelResponse, ResponsesStateRecovery } from "../../../protocol/types.js"
import { buildResponsesRecoveryRequest, buildResponsesRequest } from "./request-adapter.js"

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

export function responsesRecoveryReason(error: unknown): ResponsesStateRecovery["reason"] | "" {
  const value = record(error)
  const message = text(value.message || error)
  // 不因鉴权、限流、网络或其他参数错误重放；仅处理明确的压缩/窗口失败。
  if ([401, 403, 429].includes(Number(value.status)) || /abort|timeout/i.test(text(value.name))) return ""
  const code = text(value.code)
  if (code === "context_length_exceeded" || /context (?:length|window).*(?:exceed|too (?:large|long))|maximum context length/i.test(message)) return "context_length_exceeded"
  if (/compaction|compact_threshold|context_management/i.test(`${code} ${text(value.param)} ${message}`)) return "compaction_failed"
  if (text(value.code) === "previous_response_not_found" || /previous response.+not found|previous_response_not_found/i.test(message)) {
    return "previous_response_missing"
  }
  if (/no tool call found for function call output with call_id/i.test(message)) return "tool_call_link_missing"
  return ""
}

/**
 * Responses 会话链状态机。它只决定上游链接与本地无状态恢复，不参与工具权限、
 * 执行、重试或副作用控制；已经执行的工具结果只会被重放，不会再次执行。
 */
export class ResponsesConversationStateMachine {
  private phase: "ready" | "linked" | "recovering" | "completed" = "ready"
  private readonly request: ModelRequest
  private readonly mode: ResponsesStateMode
  private readonly initialBody: UnknownRecord

  constructor(request: ModelRequest) {
    this.request = request
    const configuredMode = text(record(request.channel.responsesRuntime).stateMode)
    this.mode = configuredMode === "local" || configuredMode === "previous_response_id" ? configuredMode : "auto"
    this.initialBody = buildResponsesRequest(request)
    this.phase = this.initialBody.previous_response_id ? "linked" : "ready"
  }

  initialRequest(): UnknownRecord {
    return this.initialBody
  }

  recoveryRequest(error: unknown): { body: UnknownRecord; recovery: ResponsesStateRecovery } | null {
    if (this.phase === "recovering" || this.phase === "completed") return null
    const reason = responsesRecoveryReason(error)
    const localFallback = reason === "compaction_failed" || reason === "context_length_exceeded"
    if (!localFallback && this.phase !== "linked") return null
    // 严格上游模式仍拒绝恢复普通断链；但当前轮已经执行完成的 Function
    // Output 若因代理丢失 Call 关联而无法回传，必须允许一次有界配对重放，
    // 否则 AgentTurn 的“需要最终回复”无法完成。重放不会再次执行工具。
    const activeToolLinkRepair = this.mode === "previous_response_id" && reason === "tool_call_link_missing"
    if (!reason || (!localFallback && !responsesAllowsStateRecovery(this.mode) && !activeToolLinkRepair)) return null
    const from = this.phase
    const replay = buildResponsesRecoveryRequest(this.request, localFallback, reason === "context_length_exceeded")
    this.phase = "recovering"
    return {
      body: replay.body,
      recovery: {
        reason,
        from,
        to: "stateless_replay",
        replayedMessages: replay.replayedMessages,
        droppedToolItems: replay.droppedToolItems,
        ...(replay.localCompaction ? { localCompaction: replay.localCompaction } : {}),
      },
    }
  }

  complete(response: ModelResponse, recovery?: ResponsesStateRecovery): ModelResponse {
    this.phase = "completed"
    return recovery ? { ...response, upstreamStateReset: true, responsesStateRecovery: recovery } : response
  }
}
