import { isDeepStrictEqual } from "node:util"
import { langfuseReporter } from "../observability/langfuse.js"
import { installationInstaller } from "../../extensions/installation/installer.js"
import { loadPersonaPunishments } from "../chat/persona-punishments.js"
import { applyActionCommands } from "../../apps/actions.js"
import { actionCommandStatus } from "./host-command-registry.js"
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
import { stickerExpressionCoordinator } from "../persona/sticker-expression-coordinator.js"
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
  previousConfig?: UnknownRecord
  startLogs?: boolean
  reinitTools?: boolean
  reinitFilters?: boolean
  restartInitiativeGreeting?: boolean
  restartStickerExpression?: boolean
  restartScheduleTasks?: boolean
  clearMutedScopes?: boolean
  clearBlockedUsers?: boolean
  clearRecentContext?: boolean
  clearObserverHandlers?: boolean
  restoreCommandPatch?: boolean
  unregisterWebSocket?: boolean
  stopInitiativeGreeting?: boolean
  stopStickerExpression?: boolean
  stopScheduleTasks?: boolean
  flushMemory?: boolean
  shutdown?: boolean
  destroyMcp?: boolean
}

export type RuntimeStats = UnknownRecord

export function runtimeStats(): RuntimeStats {
  return {
    actions: { ...actionCommandStatus },
    chat: chatService.stats(),
    recentContext: recentContextStore.stats(),
    response: responseStateStats(),
    personaTrigger: personaTriggerStats(),
    initiativeGreeting: initiativeGreetingScheduler.stats(),
    stickerExpression: stickerExpressionCoordinator.stats(),
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
    stickerExpression: null,
    scheduleTasks: null,
    groupCapture: false,
    logs: false,
  }
  const read = (value: unknown, path: string): unknown => path.split(".").reduce<unknown>((node, key) => node && typeof node === "object" ? (node as UnknownRecord)[key] : undefined, value)
  const changed = (path: string): boolean => !opts.previousConfig || !isDeepStrictEqual(read(opts.previousConfig, path), read(config, path))
  if (!opts.previousConfig) await loadPersonaPunishments()
  if (changed("logging.level") || changed("logging.history")) {
    const retentionChanged = opts.startLogs !== false ? modelLogStore.start(config) : modelLogStore.configure(config)
    if (retentionChanged) modelLogStore.cleanupExpired().catch(err => modelLogStore.noteError(err))
    result.logs = true
  }
  if (changed("logging.langfuse")) langfuseReporter.start()
  if (opts.reinitTools !== false) {
    if (!opts.previousConfig || opts.reinitTools === true || changed("tools.custom")) {
      await toolRegistry.init({ reloadMcp: changed("mcp") })
      result.tools = true
    } else if (changed("mcp")) {
      await toolRegistry.refreshMcp(opts.previousConfig?.mcp)
      result.tools = true
    } else if (changed("skills")) {
      await toolRegistry.refreshSkills()
      result.tools = true
    }
  }
  if (opts.reinitFilters !== false && (!opts.previousConfig || opts.reinitFilters === true)) {
    await filterRegistry.init()
    result.filters = true
  }
  initiativeGreetingScheduler.configure(config)
  if (opts.restartInitiativeGreeting !== false) {
    if (["enabled", "scheduledEnabled", "intervalHours"].some(key => changed(`persona.initiativeGreeting.${key}`))) result.initiativeGreeting = initiativeGreetingScheduler.start(config)
  }
  if (opts.restartStickerExpression !== false && changed("persona.stickerExpression")) {
    result.stickerExpression = stickerExpressionCoordinator.start(config)
  }
  scheduleTaskService.configure(config)
  if (opts.restartScheduleTasks !== false) {
    if (changed("tools.builtin.scheduleTask.enabled") || changed("tools.builtin.scheduleTask.tickMs")) result.scheduleTasks = scheduleTaskService.start(config)
  }
  if (groupCaptureStore.initialized) {
    if (changed("memory.groupCapture.defaultRetentionDays")) {
      await groupCaptureStore.applyConfig(config)
      result.groupCapture = true
    } else if (["memory.groupCapture.defaultTokenLimit", "memory.groupCapture.promptTemplate", "memory.groupCapture.consolidation.modelName",
      "memory.groupCapture.consolidation.maxTokens", "memory.groupCapture.consolidation.minConfidence", "memory.retrieval.resultLimit"].some(changed)) {
      // 更新继承默认值的内存策略，保持扫描计时和已触发日程不变。
      await groupCaptureStore.refreshPolicies()
      result.groupCapture = true
    }
    if (changed("memory.groupCapture.scanIntervalMs") || changed("memory.groupCapture.consolidation.schedule")) {
      groupCaptureStore.startScanner()
      result.groupCapture = true
    }
  }
  if (changed("actions")) result.actions = await applyActionCommands(config as import("../../config/types.js").RuntimeConfigObject)
  return result
}

export async function endAllConversationsRuntime(opts: RuntimeLifecycleOptions = {}): Promise<UnknownRecord> {
  const before = runtimeStats()
  const cleared = {
    conversations: await chatService.clearAll({ preserveObservationSessions: opts.shutdown === true }),
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
  if (opts.shutdown || opts.stopStickerExpression) stickerExpressionCoordinator.stop()
  if (opts.shutdown || opts.stopScheduleTasks) scheduleTaskService.stop()
  if (opts.shutdown || opts.flushMemory) await memoryStore.flush()
  if (opts.shutdown) await groupCaptureStore.stop({ flush: true })
  else if (opts.flushMemory) await groupCaptureStore.flush()
  if (opts.shutdown) {
    await installationInstaller.stop()
    await applyActionCommands({ actions: { enabled: false } })
    await langfuseReporter.stop()
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
