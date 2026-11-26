import { getToolCommon, normalizeExecutionPolicy, toolProvenance, toolSource, type NormalizedTool } from "./contract.js"
import type { UnknownRecord } from "../../core/message/types.js"

export const behaviorScopes = ["tools", "customPackages", "mcpServers"] as const
export type BehaviorScope = typeof behaviorScopes[number]
export interface BehaviorEntry { values: UnknownRecord; actions: Record<string, UnknownRecord> }
export const behaviorToolOnlyFields = ["requiresFinalReply", "continueConversation", "deferLoading", "hiddenFromModel"]
const booleans = ["requiresFinalReply", "parallelSafe", "deferLoading", "hiddenFromModel", "continueConversation"]
const choices: Record<string, readonly string[]> = {
  mode: ["foreground", "background", "silent"],
  repeatPolicy: ["allow", "bounded", "dedupe", "explicit_only"],
  retryPolicy: ["safe", "executor", "no_ambiguous_retry", "none"],
}
const ranges: Record<string, [number, number]> = { maxAttempts: [1, 5], timeoutMs: [1000, 600000], maxCount: [1, 100], maxPolls: [1, 20], minPollIntervalMs: [0, 60000] }
export function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}
export function validBehaviorId(id: unknown): id is string {
  return typeof id === "string" && Boolean(id.trim()) && !["__proto__", "constructor", "prototype"].includes(id)
}
export function validateBehaviorValues(value: unknown, allowReset = false): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工具设置必须是对象")
  for (const [key, item] of Object.entries(value)) {
    const known = booleans.includes(key) || Object.hasOwn(choices, key) || Object.hasOwn(ranges, key)
    if (!known) throw new Error(`不支持的工具设置：${key}`)
    if (allowReset && item === null) continue
    if (booleans.includes(key) ? typeof item !== "boolean"
      : choices[key] ? typeof item !== "string" || !choices[key].includes(item)
        : !Number.isInteger(item) || Number(item) < ranges[key][0] || Number(item) > ranges[key][1]) throw new Error(`无效的工具设置：${key}`)
  }
}
export function validateBehaviorConfig(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tools.behavior 必须是对象")
  for (const [scope, entries] of Object.entries(value)) {
    if (!behaviorScopes.includes(scope as BehaviorScope) || !entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("无效的工具配置范围")
    for (const [id, raw] of Object.entries(entries)) {
      if (!validBehaviorId(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("无效的工具配置目标")
      const entry = record(raw)
      if (Object.keys(entry).some(key => !["values", "actions"].includes(key))) throw new Error("未知的工具配置字段")
      validateBehaviorValues(entry.values ?? {})
      if (entry.actions !== undefined && (!entry.actions || typeof entry.actions !== "object" || Array.isArray(entry.actions))) throw new Error("动作设置必须是对象")
      for (const [action, values] of Object.entries(record(entry.actions))) {
        if (!validBehaviorId(action) || scope !== "tools") throw new Error("按动作设置只支持单个工具")
        validateBehaviorValues(values)
        if (Object.keys(record(values)).some(key => behaviorToolOnlyFields.includes(key))) throw new Error("该项只支持工具级配置")
      }
    }
  }
}
export function behaviorEntry(config: unknown, scope: BehaviorScope, id: string): BehaviorEntry {
  const entry = record(record(record(record(config).tools).behavior)[scope])[id]
  return { values: record(record(entry).values), actions: record(record(entry).actions) as Record<string, UnknownRecord> }
}
export function behaviorValues(common: unknown): UnknownRecord {
  const item = record(common), execution = record(item.execution)
  return {
    mode: execution.backgroundSilent ? "silent" : execution.background ? "background" : "foreground",
    requiresFinalReply: item.requiresFinalReply !== false,
    ...Object.fromEntries(["repeatPolicy", "retryPolicy", "maxAttempts", "timeoutMs", "parallelSafe", "maxCount", "maxPolls", "minPollIntervalMs"].map(key => [key, execution[key]])),
    deferLoading: item.deferLoading === true, hiddenFromModel: item.hiddenFromModel === true,
    continueConversation: record(item.autoDelivery).continueConversation === true,
  }
}
/** 范围默认可以留给未来能力，单工具写入和执行只采用当前能力支持的项；null 始终允许清除旧覆盖。 */
export function applicableBehaviorValues(commonValue: unknown, values: UnknownRecord): UnknownRecord {
  const common = record(commonValue), execution = record(common.execution)
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => {
    if (value === null) return true
    if (key === "mode") return record(common.policy).requiresModelContext !== true
    if (key === "parallelSafe") return execution.effect === "read" || value === false
    if (key === "maxCount") return execution.supportsCount === true
    if (["maxPolls", "minPollIntervalMs"].includes(key)) return execution.polling === true
    if (key === "continueConversation") return Boolean(common.autoDelivery)
    return true
  }))
}
function applyValues(common: UnknownRecord, input: UnknownRecord): UnknownRecord {
  const values = applicableBehaviorValues(common, input)
  const execution = { ...record(common.execution) }
  for (const key of ["repeatPolicy", "retryPolicy", "maxAttempts", "timeoutMs", "parallelSafe", "maxCount", "maxPolls", "minPollIntervalMs"]) if (values[key] !== undefined) execution[key] = values[key]
  if (values.mode !== undefined) {
    execution.background = values.mode === "background"
    execution.backgroundSilent = values.mode === "silent"
  }
  const next: UnknownRecord = { ...common, execution: normalizeExecutionPolicy(execution) }
  for (const key of ["requiresFinalReply", "hiddenFromModel", "deferLoading"]) if (values[key] !== undefined) next[key] = values[key]
  if (values.continueConversation !== undefined) next.autoDelivery = { ...record(common.autoDelivery), continueConversation: values.continueConversation }
  return next
}
export function toolBehaviorScope(tool: unknown): { scope: BehaviorScope; id: string } | null {
  const provenance = toolProvenance(tool)
  if (toolSource(tool) === "custom" && provenance.packageId) return { scope: "customPackages", id: String(provenance.packageId) }
  if (toolSource(tool) === "mcp" && provenance.serverName) return { scope: "mcpServers", id: String(provenance.serverName) }
  return null
}
/** 稀疏管理覆盖：工具原始声明 → 包/服务设置 → 单工具设置 → 当前动作设置。无覆盖时保持原对象。 */
export function applyToolBehavior(tool: NormalizedTool, config: unknown, includeTool = true, includeActions = true): NormalizedTool {
  const scope = toolBehaviorScope(tool)
  const parent = scope ? behaviorEntry(config, scope.scope, scope.id) : { values: {}, actions: {} }
  const own = includeTool ? behaviorEntry(config, "tools", tool.name) : { values: {}, actions: {} }
  const values = { ...parent.values, ...own.values }
  if (!Object.keys(values).length && !Object.keys(own.actions).length) return tool
  const base = getToolCommon(tool)
  const common = applyValues(base, values)
  common.executionByAction = Object.fromEntries(Object.entries(record(base.executionByAction)).map(([action, execution]) => [action,
    applyValues({ ...base, execution }, { ...values, ...(includeActions ? record(own.actions[action]) : {}) }).execution,
  ]))
  return { ...tool, common: common as unknown as typeof tool.common }
}
export function updateBehaviorEntry(config: UnknownRecord, scope: BehaviorScope, id: string, changes: UnknownRecord, action = "", reset = false): void {
  const tools = record(config.tools), behavior = { ...record(tools.behavior) }, entries = { ...record(behavior[scope]) }
  const current = behaviorEntry(config, scope, id)
  const values = { ...(action ? record(current.actions[action]) : current.values) }
  if (reset) for (const key of Object.keys(values)) delete values[key]
  for (const [key, value] of Object.entries(changes)) { if (value === null) delete values[key]; else values[key] = value }
  const entry = { values: action ? current.values : values, actions: { ...current.actions } }
  if (action) { if (Object.keys(values).length) entry.actions[action] = values; else delete entry.actions[action] }
  else if (reset) entry.actions = {}
  if (Object.keys(entry.values).length || Object.keys(entry.actions).length) entries[id] = entry
  else delete entries[id]
  behavior[scope] = entries
  config.tools = { ...tools, behavior }
}
