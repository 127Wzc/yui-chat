import { hostRuntime } from "../../core/runtime/host-runtime.js"
import type { UnknownRecord } from "../../core/message/types.js"
import { filterRegistry } from "../core/registry.js"
import { messageFilterTarget, sortMessageFilters, type MessageFilterTarget } from "./message-filter-contract.js"
import type { MessageChain, ContentPart, ForwardNodePart } from "../../core/message-chain/types.js"
import { mediaResourceFromValue } from "../../core/message-chain/builder.js"

export interface MessageFilterDelivery extends UnknownRecord {
  kind: "record"
  data: unknown
  continueText?: boolean
}

export interface MessageFilterResult {
  text: string
  deliveries: MessageFilterDelivery[]
  blocked: boolean
  reason: string
  traces: UnknownRecord[]
}

const defaultPriority = 100

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function filterConfig(config: unknown): UnknownRecord {
  const response = record(record(config).response)
  const canonical = response.messageFilters
  return canonical && typeof canonical === "object" && !Array.isArray(canonical) ? canonical as UnknownRecord : {}
}

function priorityOf(filter: UnknownRecord): number {
  const value = Number(filter.priority)
  return Number.isFinite(value) ? value : defaultPriority
}

function filtersForStage(config: unknown, stage: string, target: MessageFilterTarget): UnknownRecord[] {
  const filtering = filterConfig(config)
  if (filtering.enabled === false || !Array.isArray(filtering.filters)) return []
  return sortMessageFilters(filtering.filters)
    .map((filter, index) => ({ filter, index }))
    .filter(({ filter }) => filter.enabled === true && filter.stage === stage && messageFilterTarget(filter) === target)
    .sort((left, right) => priorityOf(left.filter) - priorityOf(right.filter) || left.index - right.index)
    .slice(0, 30)
    .map(({ filter }) => filter)
}

function matches(filter: UnknownRecord, value: string): boolean {
  const condition = record(filter.condition)
  return value.trim().length >= Math.max(0, Number(condition.minTextLength) || 0)
}

function implementationOf(filter: UnknownRecord): { type: string; id: string; arguments: UnknownRecord } {
  const implementation = record(filter.implementation)
  return {
    type: text(implementation.type || "filter"),
    id: text(implementation.id),
    arguments: record(implementation.arguments),
  }
}

// FilterDefinition 的正文总是由运行链路注入；参数可以使用管理端的 { value } 包装或直接保存 JSON 值。
function resolveFilterArguments(filter: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(implementationOf(filter).arguments).flatMap(([key, binding]) => {
    if (key === "text") return []
    const value = record(binding)
    if (Object.hasOwn(value, "value")) return [[key, value.value]]
    if (Object.hasOwn(value, "from")) return []
    return [[key, binding]]
  }))
}

function applyFilterResult(result: unknown, state: { text: string; deliveries: MessageFilterDelivery[]; blocked: boolean; reason: string }, stage: string): "transformed" | "blocked" | "delivered" {
  if (["string", "number", "boolean"].includes(typeof result)) {
    state.text = String(result)
    return "transformed"
  }
  const value = record(result)
  if (!Object.keys(value).length) throw new Error("过滤器实现没有返回可用结果")
  if (!value.kind && Object.hasOwn(value, "text")) {
    state.text = text(value.text)
    return "transformed"
  }
  if (value.kind === "text") {
    state.text = text(value.text)
    return "transformed"
  }
  if (value.kind === "block") {
    state.text = ""
    state.blocked = true
    state.reason = text(value.reason || "消息被过滤器拦截")
    return "blocked"
  }
  if (stage === "output" && value.kind === "record" && value.data) {
    state.deliveries.push(value as MessageFilterDelivery)
    if (value.continueText === false) state.text = ""
    return "delivered"
  }
  throw new Error("过滤器实现返回了不支持的结果；可直接返回文本，或返回 { kind: 'text' }、{ kind: 'block' }、{ kind: 'record', data }")
}

async function applyFilterChain(value: unknown, context: UnknownRecord = {}, stage: "input" | "output", target: MessageFilterTarget = "text"): Promise<MessageFilterResult> {
  const state = { text: text(value), deliveries: [] as MessageFilterDelivery[], blocked: false, reason: "" }
  const traces: UnknownRecord[] = []
  for (const filter of filtersForStage(context.config, stage, target)) {
    if (!matches(filter, state.text)) continue
    const implementation = implementationOf(filter)
    const trace: UnknownRecord = { filterId: filter.id, priority: priorityOf(filter) }
    const native = implementation.type === "filter" ? filterRegistry.get(implementation.id) : null
    if (!native || !native.stages.includes(stage)) {
      traces.push({ ...trace, status: "skipped", message: "引用的过滤器实现不存在或不支持当前阶段。" })
      continue
    }
    if (target === "media" && (native.effects.some(effect => effect !== "pure") || native.resultKinds.some(kind => kind !== "text"))) {
      traces.push({ ...trace, status: "skipped", message: "媒体链接只支持纯文本变换实现。" })
      continue
    }
    try {
      const runtimeContext: UnknownRecord = {
        ...context,
        source: "message-filter",
        stage,
        target,
        filterId: filter.id,
        filterPriority: priorityOf(filter),
      }
      const result = await filterRegistry.execute(native.id, { text: state.text, params: resolveFilterArguments(filter) }, runtimeContext)
      const status = applyFilterResult(result, state, stage)
      traces.push({ ...trace, status, filter: native.id })
      if (state.blocked) break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      hostRuntime.logger?.warn?.(`[yui-chat] 消息过滤器 ${text(filter.id || filter.name || "unknown")} 执行失败：${message}`)
      traces.push({ ...trace, status: "failed", message })
    }
  }
  return { ...state, traces }
}

// 输入过滤器链发生在安全预检之后、模型调用之前；可修改内容或短路本次模型请求。
export function applyInputFilters(value: unknown, context: UnknownRecord = {}): Promise<MessageFilterResult> {
  return applyFilterChain(value, context, "input")
}

// 输出过滤器链支持文本变换、短路和可发送的交付内容；单个过滤器失败时继续传递当前文本。
export function applyOutputFilters(value: unknown, context: UnknownRecord = {}, target: MessageFilterTarget = "text"): Promise<MessageFilterResult> {
  return applyFilterChain(value, context, "output", target)
}

/** 只遍历规范消息字段；不修改工具原结果，不检查任意 JSON 中的 URL。 */
export async function applyOutputChainFilters(chain: MessageChain, context: UnknownRecord = {}, textFiltered = false): Promise<{ chain: MessageChain; blocked: boolean; reason: string; traces: UnknownRecord[] }> {
  const traces: UnknownRecord[] = []
  let blocked = false
  let reason = ""
  const apply = async (value: string, target: MessageFilterTarget, path: string): Promise<MessageFilterResult> => {
    const result = await applyOutputFilters(value, context, target)
    traces.push(...result.traces.map(trace => ({ ...trace, target, path })))
    if (result.blocked) { blocked = true; reason = result.reason }
    return result
  }
  const visit = async (parts: MessageChain, path: string): Promise<ContentPart[]> => {
    const output: ContentPart[] = []
    for (const [index, part] of parts.entries()) {
      if (context.signal instanceof AbortSignal) context.signal.throwIfAborted()
      if (blocked) break
      const location = `${path}[${index}]`
      if (part.type === "text" && !textFiltered) {
        const result = await apply(part.text, "text", `${location}.text`)
        for (const delivery of result.deliveries) output.push({ type: "audio", source: mediaResourceFromValue(delivery.data) })
        if (result.text) output.push({ ...part, text: result.text })
      } else if (part.type === "forward") {
        const nodes = []
        for (const [nodeIndex, node] of part.nodes.entries()) nodes.push({ ...node, parts: await visit(node.parts, `${location}.nodes[${nodeIndex}].parts`) as ForwardNodePart[] })
        output.push({ ...part, nodes })
      } else output.push(part)
    }
    return output
  }
  // 先处理正文产生的语音等资源，再统一处理媒体，避免某一路输出漏过规则。
  const visitMedia = async (parts: MessageChain, path: string): Promise<ContentPart[]> => {
    const output: ContentPart[] = []
    for (const [index, part] of parts.entries()) {
      if (context.signal instanceof AbortSignal) context.signal.throwIfAborted()
      if (blocked) break
      const location = `${path}[${index}]`
      if (part.type === "forward") {
        const nodes = []
        for (const [nodeIndex, node] of part.nodes.entries()) nodes.push({ ...node, parts: await visitMedia(node.parts, `${location}.nodes[${nodeIndex}].parts`) as ForwardNodePart[] })
        output.push({ ...part, nodes })
      } else if (["image", "audio", "video", "file"].includes(part.type) && "source" in part && part.source?.kind === "url") {
        const result = await apply(part.source.value, "media", `${location}.source.value`)
        output.push({ ...part, source: { ...part.source, value: result.text } })
      } else if (part.type === "music") {
        const next = { ...part }
        for (const key of ["audio", "image"] as const) if (/^https?:\/\//i.test(next[key] || "")) next[key] = (await apply(next[key]!, "media", `${location}.${key}`)).text
        output.push(next)
      } else output.push(part)
    }
    return output
  }
  const result = await visitMedia(await visit(chain, "parts"), "parts")
  return { chain: blocked ? [] : result, blocked, reason, traces }
}
