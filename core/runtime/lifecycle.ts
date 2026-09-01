import { chatService } from "../chat/chat-service.js"
import { recentContextStore } from "../chat/recent-context.js"
import { clearResponseState, responseStateStats } from "../chat/response-pipeline.js"
import { commandObserver } from "../../knowledge/command-observer.js"
import { mcpManager } from "../../mcp/index.js"
import { toolRegistry } from "../../tools/support/registry.js"
import { filterRegistry } from "../../filters/core/registry.js"
import { unregisterWebSocket } from "../../web/http/websocket.js"
import { clearBlockedUsers, clearMutedScopes, mutedStats } from "../chat/access-control.js"
import { clearPersonaTriggerState, personaTriggerStats } from "../persona/persona-trigger.js"
import { initiativeGreetingScheduler } from "../persona/initiative-greeting.js"
import { scheduleTaskService } from "../scheduling/schedule-task-service.js"
import { memoryStore } from "../../memory/store.js"
import { modelLogStore } from "../observability/model-log.js"
import { groupCaptureStore } from "../../memory/group-capture.js"

type UnknownRecord = Record<string, unknown>

/**
 * 运行时生命周期选项。
 *
 * 这里刻意只描述编排层真正读取的开关；宿主和 Web 层可以继续传入
 * 更宽的对象，但不会把宿主对象泄漏到核心状态机中。
 */
export interface RuntimeLifecycleOptions extends UnknownRecord {
  startLogs?: boolean
  reinitTools?: boolean
  reinitFilters?: boolean
  restartInitiativeGreeting?: boolean
  restartScheduleTasks?: boolean
  clearMutedScopes?: boolean
  clearBlockedUsers?: boolean
  clearRecentContext?: boolean
  clearObserverHandlers?: boolean
  restoreCommandPatch?: boolean
  unregisterWebSocket?: boolean
  stopInitiativeGreeting?: boolean
  stopScheduleTasks?: boolean
  flushMemory?: boolean
  shutdown?: boolean
  destroyMcp?: boolean
}

export type RuntimeStats = UnknownRecord

export function runtimeStats(): RuntimeStats {
  return {
    chat: chatService.stats(),
    recentContext: recentContextStore.stats(),
    response: responseStateStats(),
    personaTrigger: personaTriggerStats(),
    initiativeGreeting: initiativeGreetingScheduler.stats(),
    scheduleTasks: scheduleTaskService.stats(),
    access: mutedStats(),
    knowledge: commandObserver.stats(),
    groupCapture: groupCaptureStore.stats(),
    mcp: mcpManager.status(),
    logs: modelLogStore.stats(),
  }
}

export async function applyRuntimeConfig(config: UnknownRecord = {}, opts: RuntimeLifecycleOptions = {}): Promise<UnknownRecord> {
  const result: UnknownRecord = {
    tools: false,
    filters: false,
    initiativeGreeting: null,
    scheduleTasks: null,
    groupCapture: false,
    logs: false,
  }
  const logRetentionChanged = opts.startLogs !== false ? modelLogStore.start(config) : modelLogStore.configure(config)
  if (logRetentionChanged) modelLogStore.cleanupExpired().catch(err => modelLogStore.noteError(err))
  result.logs = true
  if (opts.reinitTools !== false) {
    await toolRegistry.init()
    result.tools = true
  }
  if (opts.reinitFilters !== false) {
    await filterRegistry.init()
    result.filters = true
  }
  if (opts.restartInitiativeGreeting !== false) {
    result.initiativeGreeting = initiativeGreetingScheduler.start(config)
  }
  if (opts.restartScheduleTasks !== false) {
    result.scheduleTasks = scheduleTaskService.start(config)
  }
  if (groupCaptureStore.initialized) {
    await groupCaptureStore.applyConfig(config)
    groupCaptureStore.startScanner()
    result.groupCapture = true
  }
  return result
}

export async function endAllConversationsRuntime(opts: RuntimeLifecycleOptions = {}): Promise<UnknownRecord> {
  const before = runtimeStats()
  const cleared = {
    conversations: await chatService.clearAll(),
    response: clearResponseState(),
    personaTrigger: clearPersonaTriggerState(),
    mutedScopes: opts.clearMutedScopes === false ? 0 : clearMutedScopes(),
    blockedUsers: opts.clearBlockedUsers === false ? 0 : clearBlockedUsers(),
  }
  if (opts.clearRecentContext !== false) recentContextStore.clear()
  if (opts.shutdown || opts.clearObserverHandlers) {
    await commandObserver.destroy({ restorePatch: Boolean(opts.restoreCommandPatch) })
  }
  if (opts.shutdown || opts.unregisterWebSocket) unregisterWebSocket()
  if (opts.shutdown || opts.stopInitiativeGreeting) initiativeGreetingScheduler.stop()
  if (opts.shutdown || opts.stopScheduleTasks) scheduleTaskService.stop()
  if (opts.shutdown || opts.flushMemory) await memoryStore.flush()
  if (opts.shutdown) await groupCaptureStore.stop({ flush: true })
  else if (opts.flushMemory) await groupCaptureStore.flush()
  if (opts.shutdown) {
    await modelLogStore.stop({ flush: true, timeoutMs: 1500 })
    await filterRegistry.destroy()
    await toolRegistry.destroy()
  }
  else if (opts.destroyMcp) {
    await mcpManager.destroy()
    toolRegistry.removeBySource("mcp")
  }
  return {
    before,
    cleared,
    after: runtimeStats(),
  }
}

export async function shutdownRuntime(opts: RuntimeLifecycleOptions = {}): Promise<UnknownRecord> {
  return endAllConversationsRuntime({
    ...opts,
    shutdown: true,
    clearRecentContext: opts.clearRecentContext !== false,
  })
}
