import { parseJsonText, toJson } from "../../shared/format.js"

type UnknownRecord = Record<string, unknown>

interface BuilderRow {
  name: string
  type: string
  description: string
  required: string
  secret: string
  defaultValue: unknown
}

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

function rows(value: unknown): BuilderRow[] {
  return Array.isArray(value) ? value.map(item => {
    const source = record(item)
    return {
      name: String(source.name || ""), type: String(source.type || "string"), description: String(source.description || ""),
      required: String(source.required || "false"), secret: String(source.secret || "false"), defaultValue: source.defaultValue ?? "",
    }
  }) : []
}

export const CUSTOM_BUILDER_STEPS = [
  { key: "create", label: "新建", icon: "plus" },
  { key: "resources", label: "框架资源", icon: "link" },
  { key: "parameters", label: "配置参数", icon: "sliders" },
  { key: "code", label: "代码", icon: "pencil" },
  { key: "test", label: "测试", icon: "play" },
]

export const CUSTOM_FIELD_TYPES = [
  { value: "string", label: "文本" }, { value: "number", label: "数字" },
  { value: "boolean", label: "开关" }, { value: "array", label: "列表" }, { value: "object", label: "对象" },
]

const clone = (value: unknown): UnknownRecord => JSON.parse(JSON.stringify(record(value))) as UnknownRecord
const propertyRows = (schema: unknown = {}, required: unknown[] = []): BuilderRow[] => {
  const source = record(schema)
  const requiredNames = new Set(required.map(item => String(item)))
  return Object.entries(record(source.properties)).map(([name, fieldValue]) => {
    const field = record(fieldValue)
    return { name, type: String(field.type || "string"), description: String(field.description || field.title || ""), required: String(requiredNames.has(name)), secret: String(Boolean(field.secret)), defaultValue: field.default ?? "" }
  })
}
const valueFor = (row: BuilderRow): unknown => row.type === "number" && row.defaultValue !== "" ? Number(row.defaultValue) : row.type === "boolean" && row.defaultValue !== "" ? row.defaultValue === "true" : row.defaultValue
const exampleValue = (type: string): unknown => type === "number" ? 0 : type === "boolean" ? false : type === "array" ? [] : type === "object" ? {} : ""
const sourceKeys = (source: unknown, patterns: RegExp[]): string[] => [...new Set(patterns.flatMap(pattern => [...String(source || "").matchAll(pattern)].map(match => String(match[1] || ""))))]
const removedExecutionFields = new Set(["repeatable", "repeatableByAction", "idempotencyKeyFields", "idempotencyKeyFieldsByAction"])

function stripRemovedExecutionFields(tool: unknown = {}): UnknownRecord {
  return Object.fromEntries(Object.entries(record(tool)).filter(([key]) => !removedExecutionFields.has(key)))
}

export function customBuilderFromManifest(manifest: unknown = {}, id: unknown = ""): UnknownRecord {
  const source = record(manifest)
  const tool = records(source.tools)[0] || {}
  const parameterSchema = record(tool.parameters)
  const required = Array.isArray(parameterSchema.required) ? parameterSchema.required : []
  return {
    step: "create",
    toolName: String(tool.name || `${String(id).replace(/-/g, "_")}_echo`),
    toolDescription: String(tool.description || "说明这个工具会做什么，以及什么时候该使用它。"),
    requiresFinalReply: String(tool.requiresFinalReply !== false),
    execution: toJson(tool.execution || {}),
    executionByAction: toJson(tool.executionByAction || {}),
    resources: Object.entries(record(source.frameworkResources)).map(([alias, value]) => ({ alias, reference: typeof value === "string" ? value : String(record(value).reference || "") })),
    parameters: propertyRows(parameterSchema, required),
    runtimeFields: propertyRows(tool.configSchema),
  }
}

export function applyCustomBuilder(manifest: unknown, builder: UnknownRecord): UnknownRecord {
  const next = clone(manifest)
  const makeSchema = (items: BuilderRow[], includeRequired = false): UnknownRecord => {
    const properties = Object.fromEntries(items.filter(row => row.name.trim()).map(row => [row.name.trim(), {
      type: row.type || "string", ...(row.description.trim() ? { description: row.description.trim() } : {}), ...(row.defaultValue !== "" ? { default: valueFor(row) } : {}), ...(row.secret === "true" ? { secret: true } : {}),
    }]))
    return { type: "object", properties, ...(includeRequired ? { required: items.filter(row => row.name.trim() && row.required === "true").map(row => row.name.trim()) } : {}) }
  }
  const firstTool = stripRemovedExecutionFields(records(next.tools)[0] || {})
  delete firstTool.pipeline
  const execution = parseJsonText<UnknownRecord>(builder.execution || "{}", "执行策略", {})
  const executionByAction = parseJsonText<UnknownRecord>(builder.executionByAction || "{}", "按动作执行策略", {})
  next.frameworkResources = Object.fromEntries((Array.isArray(builder.resources) ? builder.resources : []).map(record)
    .filter(item => String(item.alias || "").trim() && String(item.reference || "").trim())
    .map(item => [String(item.alias).trim(), String(item.reference).trim()]))
  next.tools = [{
    ...firstTool,
    name: String(builder.toolName || "").trim(),
    description: String(builder.toolDescription || "").trim(),
    requiresFinalReply: builder.requiresFinalReply !== "false",
    ...(Object.keys(execution).length ? { execution } : {}),
    ...(Object.keys(executionByAction).length ? { executionByAction } : {}),
    parameters: makeSchema(rows(builder.parameters), true),
    configSchema: makeSchema(rows(builder.runtimeFields)),
  }, ...records(next.tools).slice(1).map(tool => {
    const normalized = stripRemovedExecutionFields(tool)
    delete normalized.pipeline
    return normalized
  })]
  return next
}

export function customTestDraft(source: unknown, builder: UnknownRecord = {}): UnknownRecord {
  const fromRows = (items: BuilderRow[]): UnknownRecord => Object.fromEntries(items.filter(row => row.name.trim()).map(row => [row.name.trim(), row.defaultValue !== "" ? valueFor(row) : exampleValue(row.type)]))
  const args = fromRows(rows(builder.parameters))
  const runtimeConfig = fromRows(rows(builder.runtimeFields))
  for (const key of sourceKeys(source, [/\bargs\??\.([A-Za-z_$][\w$]*)/g, /\bargs\[['"]([^'"]+)['"]\]/g])) if (!(key in args)) args[key] = ""
  for (const key of sourceKeys(source, [/\bcontext\.toolConfig\??\.([A-Za-z_$][\w$]*)/g, /\bcontext\.toolConfig\[['"]([^'"]+)['"]\]/g])) if (!(key in runtimeConfig)) runtimeConfig[key] = ""
  return { args, runtimeConfig }
}

export function customCommandArguments(value: unknown = {}): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}"
  const entries = Object.entries(value)
  if (!entries.length) return ""
  if (entries.some(([, item]) => item !== null && typeof item === "object")) return JSON.stringify(value)
  return entries.map(([key, item]) => {
    const text = String(item ?? "")
    return /\s/.test(text) ? `${key}=${JSON.stringify(text)}` : `${key}=${text}`
  }).join(" ")
}
