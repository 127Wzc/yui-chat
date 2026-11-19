import { cloneJsonValue } from "../../core/shared/json-values.js"
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
    let previous: RuntimeConfigObject | undefined
    const saved = await configStore.update(async current => {
      previous = cloneJsonValue(current)
      return updater(current)
    }, saveOpts)
    // 依据实际提交前后差异应用；上次热应用失败时完整重试，不能把失败当作成功缓存。
    const runtime = await applyTrackedRuntimeConfig(saved, {
      ...applyOpts,
      ...(runtimeApplyFailed ? {} : { previousConfig: previous }),
    })
    return { saved, runtime }
  })
}
