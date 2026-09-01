import { configStore } from "../../config/store.js"
import { sqliteClient } from "../../core/storage/sqlite/client.js"
import { estimateTokens } from "../../core/chat/token-budget.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { adapterRegistry } from "../adapters/registry.js"
import { providerResolver } from "../routing/provider-resolver.js"
import { resolveEmbeddingDimensions, validateVectors } from "./dimensions.js"

type UnknownRecord = Record<string, unknown>

interface BudgetState {
  used: number
  ready: Promise<void>
}

interface EmbeddingOptions {
  modelName?: string
  texts?: string[]
  dimensions?: number
  purpose?: string
  signal?: AbortSignal
  event?: unknown
  trace?: unknown
  source?: string
  taskName?: string
  metadata?: Record<string, unknown>
}

interface EmbeddingUsage {
  input: number
  output: number
  total: number
}

interface EmbeddingResult {
  vectors: number[][]
  dimensions: number
  model: string
  usage: EmbeddingUsage
}

const DAY_OFFSET_MS = 8 * 60 * 60 * 1000
const budgetLedger = new Map<string, BudgetState>()

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function today(): string {
  return new Date(Date.now() + DAY_OFFSET_MS).toISOString().slice(0, 10)
}

async function consumed(modelName: string, purpose: string): Promise<number> {
  const row = await sqliteClient.get("SELECT estimated_tokens FROM embedding_budget_daily WHERE day=? AND model_name=? AND purpose=?", [today(), modelName, purpose])
  return numberValue(row?.estimated_tokens, 0)
}

// Embedding 的预算属于资源边界，不能依赖可关闭、异步写入的可观测日志。
async function recordBudgetUsage(modelName: string, purpose: string, usage: EmbeddingUsage, estimate = 0): Promise<void> {
  const estimated = Math.max(0, numberValue(usage.input), numberValue(estimate))
  await sqliteClient.run(
    "INSERT INTO embedding_budget_daily(day, model_name, purpose, estimated_tokens, calls) VALUES(?, ?, ?, ?, 1) ON CONFLICT(day, model_name, purpose) DO UPDATE SET estimated_tokens=estimated_tokens+excluded.estimated_tokens, calls=calls+1",
    [today(), modelName, purpose, estimated],
  )
}

async function reserveBudget(modelName: string, purpose: string, estimate: number, limit: number): Promise<{ settle(actual: number): void } | null> {
  if (!(limit > 0) || !(estimate > 0)) return null
  const day = today()
  const key = `${day}|${modelName}|${purpose}`
  let state = budgetLedger.get(key)
  if (!state) {
    state = { used: 0, ready: Promise.resolve() }
    state.ready = consumed(modelName, purpose).then(value => { state!.used = value })
    budgetLedger.set(key, state)
    for (const existing of budgetLedger.keys()) {
      if (!existing.startsWith(`${day}|`)) budgetLedger.delete(existing)
    }
  }
  await state.ready
  if (state.used + estimate > limit) {
    const error = new Error("embedding 每日 Token 预算已耗尽") as Error & { code: string }
    error.code = "BUDGET_EXHAUSTED"
    throw error
  }
  state.used += estimate
  let settled = false
  return {
    settle(actual: number): void {
      if (settled) return
      settled = true
      const consumedTokens = numberValue(actual, estimate)
      state!.used += Math.max(0, consumedTokens) - estimate
    },
  }
}

/**
 * Embedding 执行器：统一负责维度校验、批量拆分和每日预算，不把向量业务散落到
 * 记忆、知识或模型适配器中。预算预留与账本写入分开，避免并发调用穿透日限额。
 */
export class EmbeddingRunner {
  async embedTexts(options: EmbeddingOptions = {}): Promise<EmbeddingResult> {
    const modelName = text(options.modelName).trim()
    const texts = Array.isArray(options.texts) ? options.texts : []
    const dimensions = numberValue(options.dimensions, 0)
    const purpose = text(options.purpose) || "embedding_knowledge"
    const source = text(options.source) || "embedding"
    const taskName = text(options.taskName)
    const metadata = options.metadata || {}
    const config = configStore.get()
    const models = Array.isArray(config.models) ? config.models.filter(item => Boolean(item) && typeof item === "object" && !Array.isArray(item)) as UnknownRecord[] : []
    const model = models.find(item => text(item.name) === modelName)
    const modelCapabilities = record(model?.capabilities)
    if (!model || modelCapabilities.embedding !== true) throw new Error("未配置可用的 embedding 模型")

    const clean = texts.map(text).map(value => value.trim()).filter(Boolean)
    if (!clean.length) return { vectors: [], dimensions: 0, model: modelName, usage: { input: 0, output: 0, total: 0 } }

    const resolvedDimensions = resolveEmbeddingDimensions(model, dimensions)
    const memoryConfig = record(config.memory)
    const retrieval = record(memoryConfig.retrieval)
    const knowledgeConfig = record(config.knowledge)
    const indexing = record(knowledgeConfig.indexing)
    const limit = purpose === "embedding_memory"
      ? numberValue(retrieval.embeddingTokensPerDay, 0)
      : numberValue(indexing.globalEmbeddingTokensPerDay, 0)
    const estimate = clean.reduce((sum, value) => sum + estimateTokens(value), 0)
    const channel = providerResolver.buildChannel(model, config)
    const adapter = adapterRegistry.get(channel.type)
    if (!adapter.supportsEmbeddings || typeof adapter.embedTexts !== "function") throw new Error(`适配器 ${adapter.id} 不支持 embedding`)

    const embedding = record(model.embedding)
    const batchSize = Math.max(1, Math.min(512, numberValue(embedding.batchSize, numberValue(indexing.batchSize, 32)) || 32))
    options.signal?.throwIfAborted?.()
    const reservation = await reserveBudget(modelName, purpose, estimate, limit)
    const vectors: number[][] = []
    let usage: EmbeddingUsage = { input: 0, output: 0, total: 0 }
    let completedTokens = 0
    try {
      for (let index = 0; index < clean.length; index += batchSize) {
        const batch = clean.slice(index, index + batchSize)
        const batchEstimate = batch.reduce((sum, value) => sum + estimateTokens(value), 0)
        const result = await adapterRegistry.embedTexts({
          channel,
          texts: batch,
          dimensions: resolvedDimensions,
          signal: options.signal,
          event: options.event,
          purpose,
          source,
          trace: options.trace,
          taskName: taskName || purpose,
          metadata,
        })
        const input = Math.max(0, numberValue(result.usage?.input, 0))
        completedTokens += input || batchEstimate
        usage = {
          input: usage.input + input,
          output: usage.output + numberValue(result.usage?.output, 0),
          total: usage.total + numberValue(result.usage?.total, 0),
        }
        vectors.push(...validateVectors(result.vectors, resolvedDimensions, batch.length))
      }
    } catch (error) {
      if (completedTokens > 0) {
        try {
          await recordBudgetUsage(modelName, purpose, usage, completedTokens)
          reservation?.settle(completedTokens)
        } catch (budgetError) {
          hostRuntime.logger?.warn?.("[yui-chat] embedding 部分用量写入预算账本失败，保留本次预留额度", budgetError)
        }
      } else {
        reservation?.settle(0)
      }
      throw error
    }
    await recordBudgetUsage(modelName, purpose, usage, completedTokens || estimate)
    reservation?.settle(completedTokens || estimate)
    return {
      vectors,
      dimensions: resolvedDimensions,
      model: modelName,
      usage: { ...usage, total: usage.total || completedTokens || estimate },
    }
  }
}

export const embeddingRunner = new EmbeddingRunner()
