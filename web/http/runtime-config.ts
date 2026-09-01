import { configStore } from "../../config/store.js"
import { applyRuntimeConfig } from "../../core/runtime/lifecycle.js"
import type { ConfigSaveOptions, RuntimeConfigObject, RuntimeConfigSnapshot, RuntimeConfigUpdater } from "../../config/types.js"
import type { RuntimeLifecycleOptions } from "../../core/runtime/lifecycle.js"

let runtimeMutationQueue: Promise<unknown> = Promise.resolve()

function enqueueRuntimeMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const pending = runtimeMutationQueue.then(operation, operation)
  runtimeMutationQueue = pending.then(() => undefined, () => undefined)
  return pending
}

export function applySavedConfig(config: RuntimeConfigObject, opts: RuntimeLifecycleOptions = {}): Promise<unknown> {
  return enqueueRuntimeMutation(() => applyRuntimeConfig(config, opts))
}

export function saveConfigAndApply(next: RuntimeConfigObject, saveOpts: ConfigSaveOptions = {}, applyOpts: RuntimeLifecycleOptions = {}): Promise<{ saved: RuntimeConfigSnapshot; runtime: unknown }> {
  return enqueueRuntimeMutation(async () => {
    const saved = await configStore.save(next, saveOpts)
    const runtime = await applyRuntimeConfig(saved, applyOpts)
    return { saved, runtime }
  })
}

export function updateConfigAndApply(updater: RuntimeConfigUpdater, saveOpts: ConfigSaveOptions = {}, applyOpts: RuntimeLifecycleOptions = {}): Promise<{ saved: RuntimeConfigSnapshot; runtime: unknown }> {
  return enqueueRuntimeMutation(async () => {
    const saved = await configStore.update(updater, saveOpts)
    const runtime = await applyRuntimeConfig(saved, applyOpts)
    return { saved, runtime }
  })
}
