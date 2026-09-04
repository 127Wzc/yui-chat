import { configStore } from "./config/store.js"
import { createWebApp, registerWebSocket } from "./web/http/app.js"
import { toolRegistry } from "./tools/support/registry.js"
import { filterRegistry } from "./filters/core/registry.js"
import { commandObserver } from "./knowledge/command-observer.js"
import { YuiChat } from "./apps/chat.js"
import { YuiChatMaster } from "./apps/master.js"
import { YuiChatFriendPoke, YuiChatGroupPoke, YuiChatNotifyPoke } from "./apps/poke.js"
import { registerFirstPersonListener } from "./core/persona/first-person-listener.js"
import { initiativeGreetingScheduler } from "./core/persona/initiative-greeting.js"
import { cleanupMediaCache } from "./core/media/media-cache.js"
import { cleanupRenderCache } from "./core/rendering/render-service.js"
import { scheduleTaskService } from "./core/scheduling/schedule-task-service.js"
import { hostRuntime } from "./core/runtime/host-runtime.js"
import { sqliteClient } from "./core/storage/sqlite/client.js"
import { SqliteRuntimeConfigRepository } from "./core/storage/sqlite/runtime-config-repository.js"
import { knowledgeStore } from "./knowledge/store.js"
import { knowledgeIndexJobs } from "./knowledge/index-jobs.js"
import { capabilityStore } from "./tools/access/capability-store.js"
import { modelLogStore } from "./core/observability/model-log.js"
import { groupCaptureStore } from "./memory/group-capture.js"

const globalKey = Symbol.for("yui-chat.initialized")
const runtimeGlobals = globalThis as unknown as Record<symbol, unknown>

function record(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function boot(): Promise<void> {
  if (runtimeGlobals[globalKey]) return
  runtimeGlobals[globalKey] = true
  const bootstrapConfig = await configStore.load()
  const sqliteStatus = await sqliteClient.init(bootstrapConfig)
  if (!sqliteStatus.available && configStore.meta().runtimeConfigBackend === "sqlite") {
    throw new Error(`SQLite 主配置不可用，已停止加载以避免套用默认配置：${sqliteStatus.error || "unknown"}`)
  }
  const config = sqliteStatus.available
    ? await configStore.attachRuntimeConfigRepository(new SqliteRuntimeConfigRepository(sqliteClient))
    : bootstrapConfig
  modelLogStore.start(config)
  modelLogStore.cleanupExpired().catch(err => modelLogStore.noteError(err))
  await knowledgeStore.init(config)
  await capabilityStore.load()
  knowledgeIndexJobs.start()
  await toolRegistry.init()
  await filterRegistry.init()
  // 指令来源只由管理台的“重新扫描”显式同步。启动时保留已有知识投影，
  // 避免重启、运行时加载顺序或第三方临时规则意外触发向量重建。
  await commandObserver.init({ scanOnReady: false })
  await groupCaptureStore.init()
  commandObserver.registerAfterHandler(e => { groupCaptureStore.record(e) })
  registerFirstPersonListener()
  initiativeGreetingScheduler.start(config)
  scheduleTaskService.start(config)
  const mediaRecognition = record(record(config).mediaRecognition)
  const response = record(record(config).response)
  const remoteFetch = record(mediaRecognition.remoteFetch)
  const render = record(response.render)
  Promise.all([
    cleanupMediaCache({ mode: "expired", cacheTtlMs: remoteFetch.cacheTtlMs }),
    cleanupRenderCache({ mode: "expired", cacheTtlMs: render.cacheTtlMs }),
  ]).then(([media, render]) => {
    if (media.files || render.files) {
      hostRuntime.logger?.mark?.(`[yui-chat] 已清理过期缓存：媒体 ${media.files} 个，渲染 ${render.files} 个`)
    }
  }).catch(err => hostRuntime.logger?.warn?.("[yui-chat] 启动清理过期缓存失败", err))

  const web = record(record(config).web)
  // Express 应用本身是“可调用函数对象”，不能经过只接受普通对象的 record()，
  // 否则会丢失 use() 和 Yunzai 的 skip_auth/quiet 扩展属性，导致 2536 服务未挂载。
  const express = hostRuntime.bot?.express as {
    use?: (...args: unknown[]) => unknown
    [name: string]: unknown
  } | undefined
  if (web.enabled && express && typeof express.use === "function") {
    const mountPath = String(web.mountPath || "/yui-chat")
    ;(express.use as (...args: unknown[]) => unknown)(mountPath, createWebApp())
    for (const listName of ["quiet", "skip_auth"]) {
      const paths = Array.isArray(express[listName]) ? express[listName] as unknown[] : []
      if (!paths.includes(mountPath)) {
        paths.push(mountPath)
        express[listName] = paths
      }
    }
    registerWebSocket()
    hostRuntime.logger?.mark?.(`[yui-chat] Web 面板已挂载：${mountPath}/`)
  }
  hostRuntime.logger?.mark?.("[yui-chat] 加载完成，命令：#yuichat / #yuihelp")
}

await boot()

export const apps = {
  YuiChat,
  YuiChatMaster,
  YuiChatGroupPoke,
  YuiChatFriendPoke,
  YuiChatNotifyPoke,
}
