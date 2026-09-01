import type { ModelStopReason } from "../../models/protocol/types.js"

export type AgentTurnPhase = "model_decision" | "tool_execution" | "finalizing" | "completed" | "completed_silent"

export interface AgentTurnSummary {
  phase: AgentTurnPhase
  lastStopReason: ModelStopReason
  finalReplyRequired: boolean
  emptyFinalRecoveryCount: number
  finalizationReason: string
}

/**
 * 单次用户请求的轻量状态机。
 *
 * 工具额度、重试和副作用仍由 execution-runtime 管理；这里仅描述模型与
 * 工具之间的 Agent Loop，以及整个请求何时可以对用户结束。
 */
export function createAgentTurnState() {
  const state: AgentTurnSummary = {
    phase: "model_decision",
    lastStopReason: "unknown",
    finalReplyRequired: false,
    emptyFinalRecoveryCount: 0,
    finalizationReason: "",
  }

  function observeModel(stopReason: ModelStopReason): void {
    if (state.phase === "completed" || state.phase === "completed_silent") return
    beginModelDecision()
    state.lastStopReason = stopReason
  }

  function beginModelDecision(): void {
    if (state.phase === "completed" || state.phase === "completed_silent") return
    state.phase = "model_decision"
  }

  function beginToolExecution(): void {
    if (state.phase === "completed" || state.phase === "completed_silent") return
    state.phase = "tool_execution"
  }

  function requestFinalReply(required = true): boolean {
    state.finalReplyRequired ||= required === true
    return state.finalReplyRequired
  }

  function beginFinalization(reason: unknown): void {
    if (state.phase === "completed" || state.phase === "completed_silent") return
    state.phase = "finalizing"
    state.finalizationReason = String(reason || "").trim() || state.finalizationReason || "AGENT_FINALIZATION"
  }

  function beginEmptyFinalRecovery(reason = "EMPTY_FINAL_RESPONSE"): boolean {
    if (!state.finalReplyRequired || state.emptyFinalRecoveryCount >= 1) return false
    state.emptyFinalRecoveryCount++
    beginFinalization(reason)
    return true
  }

  function complete(silent = false): void {
    state.phase = silent ? "completed_silent" : "completed"
  }

  function summary(): AgentTurnSummary {
    return { ...state }
  }

  return {
    state,
    beginModelDecision,
    observeModel,
    beginToolExecution,
    requestFinalReply,
    beginFinalization,
    beginEmptyFinalRecovery,
    complete,
    summary,
  }
}
