import { randomUUID } from "node:crypto"
import { hostRuntime } from "../runtime/host-runtime.js"

type UnknownRecord = Record<string, unknown>
export type BackgroundTaskStatus = "queued" | "running" | "ok" | "error" | "canceled"
export type BackgroundTaskExecutor = (signal: AbortSignal) => Promise<unknown> | unknown
export type BackgroundTaskCompletion = (task: PublicBackgroundTask) => Promise<unknown> | unknown

export interface BackgroundTaskInput {
  name?: string
  runId?: string
  parentToolId?: string
  config?: unknown
  execute?: BackgroundTaskExecutor
  onComplete?: BackgroundTaskCompletion | null
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
  controller: AbortController
  execute: BackgroundTaskExecutor
  onComplete: BackgroundTaskCompletion | null
}

interface BackgroundLimits {
  enabled: boolean
  maxConcurrent: number
  maxQueue: number
  retentionMs: number
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

function configLimits(config: unknown = {}): BackgroundLimits {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "后台任务失败")
}

/** 轻量后台任务队列；任务状态和父工具标识可直接进入链路日志。 */
export class BackgroundTaskService {
  readonly tasks = new Map<string, BackgroundTask>()
  private queue: BackgroundTask[] = []
  private active = 0

  submit(input: BackgroundTaskInput = {}): PublicBackgroundTask {
    if (typeof input.execute !== "function") throw new Error("后台任务缺少执行函数")
    const limits = configLimits(input.config)
    if (!limits.enabled) throw new Error("后台工具执行未启用")
    this.prune(limits.retentionMs)
    if (this.queue.length >= limits.maxQueue) throw new Error("后台任务队列已满，请稍后重试")

    const task: BackgroundTask = {
      id: `bg_${randomUUID()}`,
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
    this.queue.push(task)
    this.pump(limits)
    return this.public(task)
  }

  private pump(limits: BackgroundLimits = configLimits()): void {
    while (this.active < limits.maxConcurrent && this.queue.length) {
      const task = this.queue.shift()
      if (!task) break
      this.active++
      this.run(task, limits).finally(() => {
        this.active = Math.max(0, this.active - 1)
        this.pump(limits)
      })
    }
  }

  private async run(task: BackgroundTask, limits: BackgroundLimits): Promise<void> {
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
      this.prune(limits.retentionMs)
    }
  }

  cancel(id: unknown): boolean {
    const task = this.tasks.get(text(id))
    if (!task) return false
    task.controller.abort(new Error("后台任务已取消"))
    if (task.status === "queued") {
      task.status = "canceled"
      task.endedAt = now()
      this.queue = this.queue.filter(item => item.id !== task.id)
      releaseCallbacks(task)
    }
    return true
  }

  get(id: unknown): PublicBackgroundTask | null {
    return this.public(this.tasks.get(text(id)))
  }

  list(options: { limit?: unknown } = {}): PublicBackgroundTask[] {
    this.prune(configLimits().retentionMs)
    const limit = positiveBounded(options.limit, 50, 1, 200)
    return [...this.tasks.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(task => this.public(task))
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
