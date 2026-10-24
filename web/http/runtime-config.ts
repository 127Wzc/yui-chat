import { configStore } from "../../config/store.js"
import { applyRuntimeConfig } from "../../core/runtime/lifecycle.js"
import type { ConfigSaveOptions, RuntimeConfigObject, RuntimeConfigSnapshot, RuntimeConfigUpdater } from "../../config/types.js"
import type { RuntimeLifecycleOptions } from "../../core/runtime/lifecycle.js"

let runtimeMutationQueue: Promise<unknown> = Promise.resolve()
let runtimeApplyFailed = false

function enqueueRuntimeMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const pending = runtimeMutationQueue.then(operation, operation)
  runtimeMutationQueue = pending.then(() => undefined, () => undefined)
  return pending
}

async function applyTrackedRuntimeConfig(config: RuntimeConfigObject, opts: RuntimeLifecycleOptions): Promise<unknown> {
  try { const result = await applyRuntimeConfig(config, opts); runtimeApplyFailed = false; return result }
  catch (error) { runtimeApplyFailed = true; throw error }
}

export function applySavedConfig(config: RuntimeConfigObject, opts: RuntimeLifecycleOptions = {}): Promise<unknown> {
  return enqueueRuntimeMutation(() => applyTrackedRuntimeConfig(config, opts))
}

export function saveConfigAndApply(next: RuntimeConfigObject, saveOpts: ConfigSaveOptions = {}, applyOpts: RuntimeLifecycleOptions = {}): Promise<{ saved: RuntimeConfigSnapshot; runtime: unknown }> {
  return enqueueRuntimeMutation(async () => {
    const saved = await configStore.save(next, saveOpts)
    const runtime = await applyTrackedRuntimeConfig(saved, applyOpts)
    return { saved, runtime }
  })
}

export function updateConfigAndApply(updater: RuntimeConfigUpdater, saveOpts: ConfigSaveOptions = {}, applyOpts: RuntimeLifecycleOptions = {}): Promise<{ saved: RuntimeConfigSnapshot; runtime: unknown }> {
  return enqueueRuntimeMutation(async () => {
    let otherConfig = ""
    const outsideKnowledge = (config: RuntimeConfigObject): string => JSON.stringify(Object.fromEntries(Object.entries(config).filter(([key]) => key !== "knowledge")))
    const saved = await configStore.update(async current => {
      otherConfig = outsideKnowledge(current)
      return updater(current)
    }, saveOpts)
    // 知识配置由查询和索引任务逐次读取发布快照，无需重载工具、MCP 或调度器。
    // 比较实际提交结果，混合修改或其他模块配置仍走原有完整热应用。
    const runtime = outsideKnowledge(saved) === otherConfig && !runtimeApplyFailed && !Object.keys(applyOpts).length
      ? { knowledge: true, reloaded: false }
      : await applyTrackedRuntimeConfig(saved, applyOpts)
    return { saved, runtime }
  })
}
