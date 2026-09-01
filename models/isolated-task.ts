import { configStore } from "../config/store.js"
import type { RuntimeConfigObject } from "../config/types.js"
import { adapterRegistry } from "./adapters/registry.js"
import type { ResolvedModelChannel } from "./routing/provider-resolver.js"
import { providerResolver } from "./routing/provider-resolver.js"

type UnknownRecord = Record<string, unknown>

interface IsolatedTaskOptions {
  config?: RuntimeConfigObject
  taskName?: string
  channelId?: string
  timeoutMs?: number
  maxTokens?: number
  systemPrompt?: string
  prompt?: string
  event?: unknown
  purpose?: string
  source?: string
  trace?: unknown
}

interface Attempt {
  channel: string
  adapter: string
  status: "ok" | "error"
  error?: string
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : text(error || "模型请求失败")).slice(0, 300)
}

function attemptError(channel: ResolvedModelChannel, error: unknown): Attempt {
  return { channel: channel.id, adapter: channel.type, error: errorMessage(error), status: "error" }
}

/**
 * 运行无历史、无人格、无 Skill、无记忆、无 Tool 的项目模型任务。
 * 适合代码草稿等管理端辅助功能，不进入正常聊天链路。
 */
export async function runIsolatedModelTask(options: IsolatedTaskOptions = {}): Promise<UnknownRecord> {
  const config = options.config || await configStore.load()
  const chat = record(config.chat)
  const taskName = text(options.taskName || chat.defaultTask || "replyer")
  const channels = providerResolver.resolveCandidateChannels({
    taskName,
    channelId: text(options.channelId).trim() || undefined,
    config,
  })
  const timeoutMs = Math.max(10000, Math.min(180000, Number(options.timeoutMs) || 90000))
  const tasks = record(config.modelTasks)
  const task = record(tasks[taskName])
  const taskMaxTokens = Number(task.maxTokens) || 4096
  // 推理型模型的思考 token 也计入上限，调用方可以显式调大但不能越过统一边界。
  const maxTokens = Math.max(512, Math.min(65536, Number(options.maxTokens) || taskMaxTokens))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`项目 AI 生成超过 ${timeoutMs}ms`)), timeoutMs)
  const attempts: Attempt[] = []
  try {
    for (const channel of channels) {
      try {
        if (channel.type === "mock") throw new Error("当前任务使用 Mock 模型，请先配置真实模型渠道")
        const adapter = adapterRegistry.get(channel.type)
        const response = await adapterRegistry.sendMessage({
          channel,
          messages: [
            { role: "system", content: text(options.systemPrompt) },
            { role: "user", content: text(options.prompt) },
          ],
          tools: [],
          event: options.event,
          maxTokens,
          signal: controller.signal,
          purpose: text(options.purpose) || "isolated-generation",
          source: text(options.source) || "isolated-task",
          taskName,
          trace: options.trace || null,
        })
        return {
          id: response.id || "",
          text: text(response.text),
          channel: channel.id,
          adapter: adapter.id,
          task: taskName,
          usage: response.usage || {},
          attempts: [...attempts, { channel: channel.id, adapter: adapter.id, status: "ok" }],
        }
      } catch (error) {
        const failure = controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error
        attempts.push(attemptError(channel, failure))
        if (controller.signal.aborted || text(task.selectionStrategy) !== "fallback") break
      }
    }
  } finally {
    clearTimeout(timer)
  }
  const last = attempts.at(-1)
  const error = new Error(last?.error || "项目 AI 没有可用模型渠道") as Error & { attempts: Attempt[] }
  error.attempts = attempts
  throw error
}
