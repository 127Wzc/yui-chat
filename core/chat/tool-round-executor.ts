import crypto from "node:crypto"
import { modelLogStore } from "../observability/model-log.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { conversationLog } from "./conversation-log.js"
import { getToolCommon } from "../../tools/support/contract.js"
import { toolRegistry, type RegistryExecutionContext } from "../../tools/support/registry.js"
import type { UnknownRecord } from "../message/types.js"

interface ToolCall extends UnknownRecord {
  id?: unknown
  name?: unknown
  arguments?: unknown
}

interface ToolContext extends UnknownRecord {
  config?: unknown
  agent?: UnknownRecord
  executionRuntime?: unknown
  observability?: UnknownRecord
  dynamicTools?: Set<string>
}

interface ExecutionRuntimeLike {
  state: UnknownRecord
  guardToolCall(input: UnknownRecord): UnknownRecord
  recordGuard(input: UnknownRecord): unknown
  executeTool(input: UnknownRecord): Promise<unknown>
  recordExecution(input: UnknownRecord): unknown
  formatToolContent(value: unknown): string
  formatToolResult(value: UnknownRecord): string
  policyFor(tool: unknown, args?: UnknownRecord): { execution: UnknownRecord }
  shouldFinalize(): boolean
  waitForNextRound(signal?: AbortSignal): Promise<void>
}

interface PlannedToolCall {
  call: ToolCall
  callIndex: number
  tool: unknown
  guard: UnknownRecord
}

interface ExecutedToolCall {
  trace: UnknownRecord
  resultText: string
  stopReason: string
}

export interface ToolRoundResult {
  traces: UnknownRecord[]
  stopReason: string
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

function callName(call: ToolCall): string {
  return text(call.name)
}

function callArguments(call: ToolCall): UnknownRecord {
  return record(call.arguments)
}

function errorMessage(error: unknown): string {
  const value = record(error)
  return text(value.message || error)
}

function operationId(guard: UnknownRecord): string {
  const operations = Array.isArray(guard.operations) ? guard.operations : []
  return text(record(operations[0]).id)
}

function executionRuntime(value: unknown): ExecutionRuntimeLike {
  return value as ExecutionRuntimeLike
}

function normalizedToolCalls(value: unknown[]): ToolCall[] {
  return value.map(item => {
    const call = record(item)
    return { ...call, id: text(call.id || crypto.randomUUID()), name: text(call.name) }
  })
}

function runtimeObservation(context: ToolContext): UnknownRecord {
  const observability = record(context.observability)
  const trace = record(observability.trace)
  return {
    ...observability,
    trace: observability.trace || null,
    modelCallId: text(trace.currentModelCallId || observability.modelCallId),
  }
}

function toolExecutionContext(context: ToolContext): RegistryExecutionContext {
  return context as RegistryExecutionContext
}

/** 工具轮次执行器：负责单轮 guard、并行只读、顺序副作用、结果回填与拓扑日志。 */
export async function executeToolRound(options: {
  toolCalls?: unknown[]
  assistantText?: unknown
  assistantProtocol?: unknown
  workingMessages: UnknownRecord[]
  toolContext: ToolContext
  round?: number
}): Promise<ToolRoundResult> {
  const toolCalls = normalizedToolCalls(Array.isArray(options.toolCalls) ? options.toolCalls : [])
  const assistantText = text(options.assistantText)
  const workingMessages = options.workingMessages
  const toolContext = options.toolContext
  const round = Math.max(1, number(options.round, 1))
  const runtime = executionRuntime(toolContext.executionRuntime)
  workingMessages.push({
    role: "assistant",
    content: assistantText,
    ...(Object.keys(record(options.assistantProtocol)).length ? { protocol: options.assistantProtocol } : {}),
    tool_calls: toolCalls.map(call => ({
      id: text(call.id),
      type: "function",
      function: { name: callName(call), arguments: JSON.stringify(callArguments(call)) },
    })),
  })

  const executeOne = async (item: PlannedToolCall): Promise<ExecutedToolCall> => {
    const { call, callIndex, guard, tool } = item
    const agent = record(toolContext.agent)
    const signal = agent.signal instanceof AbortSignal ? agent.signal : undefined
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("子代理执行已终止")
    const started = Date.now()
    const common = getToolCommon(tool)
    let result: UnknownRecord
    let executionRecord: UnknownRecord
    const name = callName(call)
    const decision = text(guard.decision)
    if (decision === "skip" || decision === "finalize") {
      const ended = Date.now()
      executionRecord = record(runtime.recordGuard({ guard, call, startedAt: started, endedAt: ended }))
      result = {
        status: decision === "skip" ? "skipped" : "blocked",
        value: guard.message,
        attempt: 0,
        retryAllowed: false,
      }
    } else {
      result = record(await runtime.executeTool({
        guard,
        signal,
        invoke: async (args: UnknownRecord, attempt: number, executionContext: UnknownRecord) => {
          try {
            const execution = {
              ...executionContext,
              runtime,
              operationId: operationId(guard),
              toolName: name,
              attempt,
              toolCallId: text(call.id),
              onBackgroundComplete: async (task: unknown) => {
                const background = record(task)
                const taskText = runtime.formatToolContent(background.result || background.error || "后台任务已结束")
                const taskStarted = number(background.startedAt, started)
                const taskEnded = number(background.endedAt, Date.now())
                modelLogStore.recordToolCall(record(toolContext.observability).trace, {
                  modelCallId: text(record(record(toolContext.observability).trace).currentModelCallId || record(toolContext.observability).modelCallId),
                  parentToolId: text(call.id),
                  round,
                  callIndex: callIndex + 1,
                  toolCallId: text(background.id),
                  toolName: name,
                  source: text(common.source),
                  category: text(common.category),
                  status: background.status === "ok" ? "ok" : text(background.status),
                  startedAt: taskStarted,
                  endedAt: taskEnded,
                  durationMs: Math.max(0, taskEnded - taskStarted),
                  delivery: text(common.delivery || "silent"),
                  requiresFinalReply: false,
                  arguments: executionRecord?.normalizedArgs || callArguments(call),
                  result: taskText,
                  resultChars: taskText.length,
                  error: background.error || "",
                  metadata: { background: true, taskId: text(background.id), parentToolId: text(call.id) },
                })
              },
            }
            return await toolRegistry.execute(name, args || {}, toolExecutionContext({
              ...toolContext,
              signal: executionContext?.signal || signal,
              agent: Object.keys(agent).length ? { ...agent, signal: executionContext?.signal || signal } : toolContext.agent,
              round,
              execution,
              observability: {
                ...runtimeObservation(toolContext),
                toolCallId: text(call.id),
                round,
              },
            }))
          } catch (error) {
            const message = errorMessage(error)
            if (/权限|主人|群管理员|群聊|权限组|未启用|全局关闭|策略未允许/.test(message)) {
              const permissionError = new Error([
                `权限不足：工具 ${name} 未执行。`,
                `原因：${message || "当前上下文没有权限执行该工具。"}`,
                "下一步：请让具备权限的主人/群管理员在当前会话中重新发起，或到 Web 工具权限里调整该工具的可见范围。",
              ].join("\n"))
              Object.assign(permissionError, { permissionDenied: true })
              throw permissionError
            }
            throw error
          }
        },
      }))
      const ended = Date.now()
      executionRecord = record(runtime.recordExecution({ guard, call, result, startedAt: started, endedAt: ended }))
      if (["failed", "ambiguous", "denied", "canceled"].includes(text(executionRecord.status))) {
        hostRuntime.logger?.warn?.(`[yui-chat] 工具 ${name} ${text(executionRecord.status)}`, result.error || result.value)
      }
    }

    const internalStatus = text(executionRecord.status || result.status || "success")
    const status = internalStatus === "success" ? "ok" : internalStatus
    const rawResultText = runtime.formatToolContent(executionRecord.content ?? result.value ?? result)
    const resultText = runtime.formatToolResult({ ...executionRecord, content: rawResultText, status })
    const outputMetadata = record(executionRecord.metadata)
    const requiresFinalReply = ["success", "accepted"].includes(internalStatus) ? common.requiresFinalReply !== false : true
    const ended = Date.now()
    const durationMs = ended - started
    const policy = runtime.policyFor(tool, callArguments(call))
    const executionPolicy = record(policy.execution)
    const deduplicated = internalStatus === "skipped"
    const error = result.error ? errorMessage(result.error).slice(0, 500) : ""
    conversationLog.toolCompleted(toolContext.config, {
      round,
      name,
      status,
      error,
      durationMs,
      resultChars: rawResultText.length,
      delivery: text(common.delivery || "silent"),
      requiresFinalReply,
      deduplicated,
      operationId: text(executionRecord.operationId),
      operationFamily: text(executionPolicy.operationFamily),
      effect: text(executionPolicy.effect),
      repeatPolicy: text(executionPolicy.repeatPolicy),
      retryPolicy: text(executionPolicy.retryPolicy),
      dispatched: executionRecord.dispatched === true,
      decision: text(executionRecord.decision || guard.decision),
      guardCode: text(executionRecord.guardCode || guard.code),
      attempt: number(executionRecord.attempt || result.attempt),
      requestedCount: number(executionRecord.requestedCount),
      executedCount: number(executionRecord.executedCount),
      completedCount: number(executionRecord.completedCount),
      remainingCount: number(executionRecord.remainingCount),
      retryAllowed: executionRecord.retryAllowed !== false,
      parentToolId: text(record(toolContext.observability).toolCallId),
      outputKind: text(outputMetadata.outputKind),
      contentTypes: Array.isArray(outputMetadata.contentTypes) ? outputMetadata.contentTypes : [],
      mediaPartCount: number(outputMetadata.mediaPartCount),
      receiptStatus: text(outputMetadata.receiptStatus),
    })
    modelLogStore.recordToolCall(record(toolContext.observability).trace, {
      modelCallId: text(record(record(toolContext.observability).trace).currentModelCallId || record(toolContext.observability).modelCallId),
      parentToolId: text(record(toolContext.observability).toolCallId),
      round,
      callIndex: callIndex + 1,
      toolCallId: text(call.id),
      toolName: name,
      source: text(common.source),
      category: text(common.category),
      status,
      startedAt: started,
      endedAt: ended,
      durationMs,
      delivery: text(common.delivery || "silent"),
      requiresFinalReply,
      arguments: executionRecord.normalizedArgs || callArguments(call),
      result: rawResultText,
      resultChars: rawResultText.length,
      error,
      metadata: {
        repeatPolicy: text(executionPolicy.repeatPolicy),
        retryPolicy: text(executionPolicy.retryPolicy),
        dispatched: executionRecord.dispatched === true,
        deduplicated,
        operationId: text(executionRecord.operationId),
        operationIds: Array.isArray(executionRecord.operationIds) ? executionRecord.operationIds : [],
        operationFamily: text(executionPolicy.operationFamily),
        effect: text(executionPolicy.effect),
        decision: text(executionRecord.decision || guard.decision),
        guardCode: text(executionRecord.guardCode || guard.code),
        attempt: number(executionRecord.attempt || result.attempt),
        requestedCount: number(executionRecord.requestedCount),
        executedCount: number(executionRecord.executedCount),
        completedCount: number(executionRecord.completedCount),
        remainingCount: number(executionRecord.remainingCount),
        retryAllowed: executionRecord.retryAllowed !== false,
        resultFingerprint: text(executionRecord.resultFingerprint),
        ...record(executionRecord.metadata),
      },
    })
    return {
      trace: {
        round,
        id: text(call.id),
        name,
        arguments: executionRecord.normalizedArgs || callArguments(call),
        status,
        error,
        durationMs,
        resultPreview: rawResultText.slice(0, 300),
        resultChars: rawResultText.length,
        delivery: text(common.delivery || "silent"),
        requiresFinalReply,
        repeatPolicy: text(executionPolicy.repeatPolicy),
        retryPolicy: text(executionPolicy.retryPolicy),
        dispatched: executionRecord.dispatched === true,
        deduplicated,
        operationId: text(executionRecord.operationId),
        operationIds: Array.isArray(executionRecord.operationIds) ? executionRecord.operationIds : [],
        operationFamily: text(executionPolicy.operationFamily),
        effect: text(executionPolicy.effect),
        decision: text(executionRecord.decision || guard.decision),
        guardCode: text(executionRecord.guardCode || guard.code),
        attempt: number(executionRecord.attempt || result.attempt),
        requestedCount: number(executionRecord.requestedCount),
        executedCount: number(executionRecord.executedCount),
        completedCount: number(executionRecord.completedCount),
        remainingCount: number(executionRecord.remainingCount),
        retryAllowed: executionRecord.retryAllowed !== false,
        resultFingerprint: text(executionRecord.resultFingerprint),
        parentToolId: text(record(toolContext.observability).toolCallId),
        metadata: record(executionRecord.metadata),
      },
      resultText,
      stopReason: runtime.shouldFinalize() ? text(runtime.state.finalizationReason || "RUNTIME_GUARD") : "",
    }
  }

  const planned: PlannedToolCall[] = toolCalls.map((call, callIndex) => {
    const tool = toolRegistry.get(callName(call))
    return { call, callIndex, tool, guard: runtime.guardToolCall({ tool, call, context: toolContext, round }) }
  })
  const parallelReadBatch = planned.length > 1
    && planned.every(item => ["allow", "rewrite"].includes(text(item.guard.decision)))
    && planned.every(item => text(record(runtime.policyFor(item.tool, callArguments(item.call)).execution).effect) === "read")
    && planned.every(item => record(runtime.policyFor(item.tool, callArguments(item.call)).execution).parallelSafe === true)
  const results: ExecutedToolCall[] = parallelReadBatch
    ? await Promise.all(planned.map(item => executeOne(item)))
    : await planned.reduce<Promise<ExecutedToolCall[]>>(async (promise, item) => [...await promise, await executeOne(item)], Promise.resolve([]))
  const traces = results.map(item => item.trace)
  const stopReason = results.map(item => item.stopReason).find(Boolean) || ""
  for (const item of results) {
    workingMessages.push({
      role: "tool",
      tool_call_id: text(item.trace.id),
      name: text(item.trace.name),
      content: item.resultText,
    })
  }
  for (const trace of traces) {
    const loadTools = record(trace.metadata).loadTools
    const loaded = Array.isArray(loadTools) ? loadTools : []
    for (const name of loaded) toolContext.dynamicTools?.add?.(text(name))
  }
  return { traces, stopReason }
}
