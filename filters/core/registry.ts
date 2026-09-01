import { cloneJsonValue } from "../../core/shared/json-values.js"
import { hostRuntime } from "../../core/runtime/host-runtime.js"
import { createBuiltinFilters } from "../builtins/index.js"
import { filterSummary, normalizeFilter, type FilterStage, type NormalizedFilter } from "./contract.js"
import { customFilterManager } from "../custom/manager.js"
import type { UnknownRecord } from "../../core/message/types.js"

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function filterConfigDefaults(schema: unknown = {}): UnknownRecord {
  const normalized = record(schema)
  const defaults = cloneJsonValue(record(normalized.default))
  for (const [name, fieldValue] of Object.entries(record(normalized.properties))) {
    const field = record(fieldValue)
    if (!(name in defaults) && field.default !== undefined) defaults[name] = cloneJsonValue(field.default)
  }
  return defaults
}

/** 计算过滤器运行变量；配置只读，试跑覆盖项只能在本次执行中生效。 */
export function resolveFilterRuntimeConfig(
  filter: UnknownRecord = {},
  config: unknown = {},
  overrides: unknown = {},
): Readonly<UnknownRecord> {
  const root = record(config)
  const response = record(root.response)
  const messageFilters = record(response.messageFilters)
  const stored = record(record(messageFilters.runtimeVariables)[text(filter.id)])
  return Object.freeze({
    ...filterConfigDefaults(filter.configSchema),
    ...cloneJsonValue(stored),
    ...cloneJsonValue(record(overrides)),
  })
}

interface FilterExecutionPayload {
  text?: unknown
  params?: unknown
}

interface FilterExecutionContext extends UnknownRecord {
  config?: unknown
  stage?: string
  filterConfig?: unknown
}

interface RegistryError extends UnknownRecord {
  filter: string
  kept: string
  skipped: string
  message: string
}

/**
 * 内置与 Custom Filter 的统一注册表。
 *
 * 注册表只负责加载、去重、运行变量和执行分发；权限、模型工具上下文和实际消息发送
 * 仍由各自的聊天/输出管线负责，避免过滤器重新变成隐式 Tool。
 */
export class FilterRegistry {
  readonly filters = new Map<string, NormalizedFilter>()
  customErrors: unknown[] = []
  registryErrors: RegistryError[] = []

  async init(): Promise<void> {
    this.filters.clear()
    this.registryErrors = []
    for (const filter of createBuiltinFilters()) this.register(filter)

    const custom = await customFilterManager.loadFilters()
    this.customErrors = custom.errors || []
    for (const filter of custom.filters || []) this.register(filter)

    if (this.registryErrors.length) {
      hostRuntime.logger?.warn?.(`[yui-chat] ${this.registryErrors.length} 个同名过滤器被跳过：${this.registryErrors.map(item => item.filter).join(", ")}`)
    }
    if (this.customErrors.length) {
      hostRuntime.logger?.warn?.(`[yui-chat] ${this.customErrors.length} 个 Custom 过滤器未加载`)
    }
  }

  async destroy(): Promise<void> {
    await customFilterManager.dispose()
    this.filters.clear()
    this.customErrors = []
    this.registryErrors = []
  }

  register(definition: unknown): boolean {
    const filter = normalizeFilter(definition)
    if (!filter) return false
    const existing = this.filters.get(filter.id)
    if (existing) {
      this.registryErrors.push({
        filter: filter.id,
        kept: existing.source || "unknown",
        skipped: filter.source || "unknown",
        message: `过滤器 ${filter.id} 已由 ${existing.source || "unknown"} 注册，跳过 ${filter.source || "unknown"} 的同名实现`,
      })
      return false
    }
    this.filters.set(filter.id, filter)
    return true
  }

  removeBySource(source: unknown): number {
    let count = 0
    for (const [id, filter] of this.filters) {
      if (filter.source !== text(source)) continue
      this.filters.delete(id)
      count++
    }
    return count
  }

  get(id: unknown): NormalizedFilter | null {
    return this.filters.get(text(id)) || null
  }

  list(): UnknownRecord[] {
    return [...this.filters.values()].map(filter => cloneJsonValue(filterSummary(filter)))
  }

  async execute(id: unknown, payload: FilterExecutionPayload = {}, context: FilterExecutionContext = {}): Promise<unknown> {
    const filter = this.get(id)
    if (!filter) throw new Error(`Filter ${text(id)} not found`)
    const stage = text(context.stage)
    if (stage && !filter.stages.includes(stage as FilterStage)) {
      throw new Error(`过滤器 ${filter.id} 不支持 ${stage} 阶段`)
    }
    const config = context.config || {}
    const params = record(payload.params)
    const filterConfig = resolveFilterRuntimeConfig(filter, config, context.filterConfig)
    return filter.apply({ text: String(payload.text ?? ""), params }, {
      ...context,
      config,
      filterConfig,
    })
  }

  customStatus(): UnknownRecord {
    const loaded = [...this.filters.values()].filter(filter => filter.source === "custom")
    const byPackage = new Map<string, UnknownRecord[]>()
    for (const filter of loaded) {
      const packageId = filter.packageId || "unknown"
      if (!byPackage.has(packageId)) byPackage.set(packageId, [])
      byPackage.get(packageId)?.push(filterSummary(filter))
    }
    return {
      catalog: (customFilterManager.catalog || []).map(item => ({
        ...item,
        loadedFilters: byPackage.get(text(item.id)) || [],
      })),
      loaded: loaded.map(filter => filter.id),
      errors: [...this.customErrors, ...this.registryErrors.filter(item => item.skipped === "custom")],
    }
  }
}

export const filterRegistry = new FilterRegistry()
