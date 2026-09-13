import { randomUUID } from "node:crypto"
import { hostRuntime } from "../runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>
export type BackgroundTaskStatus = "queued" | "running" | "ok" | "error" | "canceled"
export type BackgroundTaskExecutor = (signal: AbortSignal) => Promise<unknown> | unknown
export type BackgroundTaskCompletion = (task: PublicBackgroundTask) => Promise<unknown> | unknown
export interface BackgroundTaskLimits {
  enabled: boolean
  maxConcurrent: number
  maxQueue: number
  retentionMs: number
}
export type BackgroundTaskLimitsProvider = () => Partial<BackgroundTaskLimits> | BackgroundTaskLimits | unknown

export interface BackgroundTaskInput {
  name?: string
  runId?: string
  parentToolId?: string
  config?: unknown
  execute?: BackgroundTaskExecutor
  onComplete?: BackgroundTaskCompletion | null
  /** 同一队列内按 maxConcurrent/maxQueue 调度；未提供时使用 default。 */
  queueKey?: unknown
  maxConcurrent?: unknown
  maxQueue?: unknown
  retentionMs?: unknown
  limitsProvider?: BackgroundTaskLimitsProvider | null
}

export interface PublicBackgroundTask {
  id: string
  name: string
  runId: string
  parentToolId: string
  status: BackgroundTaskStatus
  createdAt: number
  startedAt: number
  endedAt: number
  result: unknown
  error: string
}

interface BackgroundTask extends PublicBackgroundTask {
  queueKey: string
  controller: AbortController
  execute: BackgroundTaskExecutor
  onComplete: BackgroundTaskCompletion | null
}

interface TaskQueue {
  key: string
  queue: BackgroundTask[]
  active: number
  resolveLimits: () => BackgroundTaskLimits
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function positiveBounded(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? Math.max(min, Math.min(max, numberValue)) : fallback
}

function now(): number {
  return Date.now()
}

const releasedExecutor: BackgroundTaskExecutor = () => undefined

function releaseCallbacks(task: BackgroundTask): void {
  task.execute = releasedExecutor
  task.onComplete = null
}

function configLimits(config: unknown = {}): BackgroundTaskLimits {
  const root = record(config)
  const chat = record(root.chat)
  const execution = record(chat.execution)
  const settings = record(execution.background)
  return {
    enabled: settings.enabled !== false,
    maxConcurrent: positiveBounded(settings.maxConcurrent, 4, 1, 32),
    maxQueue: positiveBounded(settings.maxQueue, 50, 1, 1000),
    retentionMs: positiveBounded(settings.retentionMs, 86400000, 60000, 7 * 86400000),
  }
}

function mergeLimits(base: BackgroundTaskLimits, override: unknown = {}): BackgroundTaskLimits {
  const value = record(override)
  return {
    enabled: value.enabled === undefined ? base.enabled : value.enabled !== false,
    maxConcurrent: positiveBounded(value.maxConcurrent, base.maxConcurrent, 1, 32),
    // 允许 0，表示不接收等待任务；有空闲并发槽时仍可立即执行。
    maxQueue: positiveBounded(value.maxQueue, base.maxQueue, 0, 1000),
    retentionMs: positiveBounded(value.retentionMs, base.retentionMs, 60000, 7 * 86400000),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "后台任务失败")
}

/** 轻量后台任务队列；任务状态和父工具标识可直接进入链路日志。 */
export class BackgroundTaskService {
  readonly tasks = new Map<string, BackgroundTask>()
  private queues = new Map<string, TaskQueue>()

  private queueInfo(input: BackgroundTaskInput): { key: string; initial: BackgroundTaskLimits; resolveLimits: () => BackgroundTaskLimits } {
    const key = text(input.queueKey).trim().slice(0, 120) || "default"
    const fixed = {
      maxConcurrent: input.maxConcurrent,
      maxQueue: input.maxQueue,
      retentionMs: input.retentionMs,
    }
    const resolveLimits = (): BackgroundTaskLimits => {
      const base = configLimits(input.config)
      let provided: unknown = {}
      if (typeof input.limitsProvider === "function") {
        try {
          provided = input.limitsProvider()
        } catch (error) {
          hostRuntime.logger?.warn?.(`[yui-chat] 后台任务队列 ${key} 限额读取失败`, error)
        }
      }
      return mergeLimits(base, { ...fixed, ...record(provided) })
    }
    return { key, initial: resolveLimits(), resolveLimits }
  }

  private queueFor(info: { key: string; initial: BackgroundTaskLimits; resolveLimits: () => BackgroundTaskLimits }): TaskQueue {
    const current = this.queues.get(info.key)
    if (current) {
      // 新提交会刷新 provider，配置热更新后下一次 pump 即使用最新限额。
      current.resolveLimits = info.resolveLimits
      return current
    }
    const created: TaskQueue = { key: info.key, queue: [], active: 0, resolveLimits: info.resolveLimits }
    this.queues.set(info.key, created)
    return created
  }

  private safeLimits(queue: TaskQueue, fallback = configLimits()): BackgroundTaskLimits {
    try {
      return queue.resolveLimits()
    } catch (error) {
      hostRuntime.logger?.warn?.(`[yui-chat] 后台任务队列 ${queue.key} 限额读取失败`, error)
      return fallback
    }
  }

  private cleanupQueue(queue: TaskQueue): void {
    if (queue.active === 0 && queue.queue.length === 0 && this.queues.get(queue.key) === queue) this.queues.delete(queue.key)
  }

  submit(input: BackgroundTaskInput = {}): PublicBackgroundTask {
    if (typeof input.execute !== "function") throw new Error("后台任务缺少执行函数")
    const info = this.queueInfo(input)
    if (!info.initial.enabled) throw new Error("后台工具执行未启用")
    this.prune(info.initial.retentionMs)
    const queue = this.queueFor(info)
    const limits = this.safeLimits(queue, info.initial)
    if (!limits.enabled) {
      this.cleanupQueue(queue)
      throw new Error("后台工具执行未启用")
    }
    // maxQueue 只限制等待项；有空闲并发槽时，新任务可以直接进入执行。
    if (queue.active >= limits.maxConcurrent && queue.queue.length >= limits.maxQueue) {
      this.cleanupQueue(queue)
      throw new Error("后台任务队列已满，请稍后重试")
    }

    const task: BackgroundTask = {
      id: `bg_${randomUUID()}`,
      queueKey: info.key,
      name: text(input.name) || "background-tool",
      runId: text(input.runId),
      parentToolId: text(input.parentToolId),
      status: "queued",
      createdAt: now(),
      startedAt: 0,
      endedAt: 0,
      result: null,
      error: "",
      controller: new AbortController(),
      execute: input.execute,
      onComplete: input.onComplete || null,
    }
    this.tasks.set(task.id, task)
    queue.queue.push(task)
    this.pump(queue)
    return this.public(task)
  }

  private pump(queue: TaskQueue): void {
    const limits = this.safeLimits(queue)
    if (!limits.enabled) return
    while (queue.active < limits.maxConcurrent && queue.queue.length) {
      const task = queue.queue.shift()
      if (!task) break
      queue.active++
      void this.run(task, queue).finally(() => {
        queue.active = Math.max(0, queue.active - 1)
        this.pump(queue)
        this.cleanupQueue(queue)
      })
    }
  }

  private async run(task: BackgroundTask, queue: TaskQueue): Promise<void> {
    if (task.controller.signal.aborted) {
      task.status = "canceled"
      task.endedAt = now()
      releaseCallbacks(task)
      return
    }
    task.status = "running"
    task.startedAt = now()
    try {
      task.result = await task.execute(task.controller.signal)
      task.status = task.controller.signal.aborted ? "canceled" : "ok"
    } catch (error) {
      task.error = errorMessage(error).slice(0, 500)
      task.status = task.controller.signal.aborted ? "canceled" : "error"
      hostRuntime.logger?.warn?.(`[yui-chat] 后台工具任务 ${task.name} ${task.status}`, task.error)
    } finally {
      task.endedAt = now()
      const onComplete = task.onComplete
      try {
        await onComplete?.(this.public(task))
      } catch (error) {
        hostRuntime.logger?.warn?.(`[yui-chat] 后台工具任务回调失败：${task.name}`, error)
      } finally {
        // 状态仍按保留期可查，但完成后不再持有执行上下文、事件与参考图闭包。
        releaseCallbacks(task)
      }
      this.prune(this.safeLimits(queue).retentionMs)
    }
  }

  cancel(id: unknown): boolean {
    const task = this.tasks.get(text(id))
    if (!task) return false
    task.controller.abort(new Error("后台任务已取消"))
    if (task.status === "queued") {
      task.status = "canceled"
      task.endedAt = now()
      const queue = this.queues.get(task.queueKey)
      if (queue) {
        queue.queue = queue.queue.filter(item => item.id !== task.id)
        this.cleanupQueue(queue)
      }
      releaseCallbacks(task)
    }
    return true
  }

  get(id: unknown): PublicBackgroundTask | null {
    return this.public(this.tasks.get(text(id)))
  }

  list(options: { limit?: unknown } = {}): PublicBackgroundTask[] {
    this.refresh()
    this.prune(configLimits().retentionMs)
    const limit = positiveBounded(options.limit, 50, 1, 200)
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(task => this.public(task))
  }

  /** 配置热更新后让等待中的队列立即按新限额泵送。 */
  refresh(): void {
    for (const queue of [...this.queues.values()]) {
      this.pump(queue)
      this.cleanupQueue(queue)
    }
    this.prune(configLimits().retentionMs)
  }

  private prune(retentionMs: number): void {
    const cutoff = now() - retentionMs
    for (const [id, task] of this.tasks) {
      if (task.endedAt && task.endedAt < cutoff) this.tasks.delete(id)
    }
  }

  private public(task: BackgroundTask): PublicBackgroundTask
  private public(task: BackgroundTask | undefined): PublicBackgroundTask | null
  private public(task: BackgroundTask | undefined): PublicBackgroundTask | null {
    if (!task) return null
    return {
      id: task.id,
      name: task.name,
      runId: task.runId,
      parentToolId: task.parentToolId,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      result: task.result,
      error: task.error,
    }
  }
}

export const backgroundTaskService = new BackgroundTaskService()
