export const CUSTOM_FILTER_BUILDER_STEPS = [
  { key: "create", label: "新建", icon: "plus" },
  { key: "resources", label: "框架资源", icon: "link" },
  { key: "parameters", label: "参数", icon: "sliders" },
  { key: "code", label: "代码", icon: "pencil" },
  { key: "test", label: "测试", icon: "play" },
]

export const CUSTOM_FILTER_FIELD_TYPES = [
  { value: "string", label: "文本" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "开关" },
  { value: "array", label: "列表" },
  { value: "object", label: "对象" },
]

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

const clone = (value: unknown): UnknownRecord => JSON.parse(JSON.stringify(record(value))) as UnknownRecord
const sourceKeys = (source: unknown, patterns: RegExp[]): string[] => [...new Set(patterns.flatMap(pattern => [...String(source || "").matchAll(pattern)].map(match => String(match[1] || ""))))]
const exampleValue = (type: string): unknown => type === "number" ? 0 : type === "boolean" ? false : type === "array" ? [] : type === "object" ? {} : ""
const valueFor = (row: BuilderRow): unknown => row.type === "number" && row.defaultValue !== "" ? Number(row.defaultValue) : row.type === "boolean" && row.defaultValue !== "" ? row.defaultValue === "true" : row.defaultValue

function propertyRows(schema: unknown = {}, required: unknown[] = []): BuilderRow[] {
  const source = record(schema)
  const requiredNames = new Set(required.map(item => String(item)))
  return Object.entries(record(source.properties)).map(([name, fieldValue]) => {
    const field = record(fieldValue)
    return {
    name,
    type: String(field.type || "string"),
    description: String(field.description || field.title || ""),
    required: String(requiredNames.has(name)),
    secret: String(Boolean(field.secret)),
    defaultValue: field.default ?? "",
    }
  })
}

function makeSchema(items: BuilderRow[] = [], includeRequired = false): UnknownRecord {
  const properties = Object.fromEntries(items
    .filter(row => row.name.trim())
    .map(row => [row.name.trim(), {
      type: row.type || "string",
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
      ...(row.defaultValue !== "" ? { default: valueFor(row) } : {}),
      ...(row.secret === "true" ? { secret: true } : {}),
    }]))
  return {
    type: "object",
    properties,
    ...(includeRequired ? { required: items.filter(row => row.name.trim() && row.required === "true").map(row => row.name.trim()) } : {}),
  }
}

export function stagesFromBuilder(builder: UnknownRecord = {}): string[] {
  if (builder.stage === "both") return ["input", "output"]
  return [builder.stage === "input" ? "input" : "output"]
}

export function customFilterBuilderFromManifest(manifest: unknown = {}, id: unknown = ""): UnknownRecord {
  const source = record(manifest)
  const filter = records(source.filters)[0] || {}
  const stages = Array.isArray(filter.stages) ? filter.stages.map(String) : []
  const effects = Array.isArray(filter.effects) ? filter.effects.map(String) : []
  const parameterSchema = record(filter.parameters)
  const required = Array.isArray(parameterSchema.required) ? parameterSchema.required : []
  return {
    step: "create",
    filterId: String(filter.id || `${String(id).replace(/-/g, "_") || "new_filter"}_filter`),
    displayName: String(filter.displayName || filter.displayNameZh || "我的代码过滤器"),
    description: String(filter.description || "处理消息正文。"),
    stage: stages.includes("input") && stages.includes("output") ? "both" : stages.includes("input") ? "input" : "output",
    effect: effects.includes("delivery") ? "delivery" : effects.includes("network") ? "network" : "pure",
    resources: Object.entries(record(source.frameworkResources)).map(([alias, value]) => ({ alias, reference: typeof value === "string" ? value : String(record(value).reference || "") })),
    parameters: propertyRows(parameterSchema, required),
    runtimeFields: propertyRows(filter.configSchema),
  }
}

export function applyCustomFilterBuilder(manifest: unknown = {}, builder: UnknownRecord = {}): UnknownRecord {
  const { tools: _legacyTools, ...next } = clone(manifest)
  const previous = records(next.filters)[0] || {}
  const parameterRows = rows(builder.parameters).filter(row => row.name.trim() !== "text")
  next.frameworkResources = Object.fromEntries((Array.isArray(builder.resources) ? builder.resources : []).map(record)
    .filter(item => String(item.alias || "").trim() && String(item.reference || "").trim())
    .map(item => [String(item.alias).trim(), String(item.reference).trim()]))
  next.filters = [{
    ...previous,
    id: String(builder.filterId || "").trim(),
    displayName: String(builder.displayName || "").trim(),
    description: String(builder.description || "").trim(),
    stages: stagesFromBuilder(builder),
    effects: [builder.effect === "delivery" ? "delivery" : builder.effect === "network" ? "network" : "pure"],
    // text 是过滤链自动注入的上下文，不属于可配置参数。
    parameters: makeSchema(parameterRows, true),
    configSchema: makeSchema(rows(builder.runtimeFields)),
  }, ...records(next.filters).slice(1)]
  return next
}

export function customFilterCodeExample(builder: UnknownRecord = {}): string {
  const id = String(builder.filterId || "custom_filter").replace(/[^a-zA-Z0-9_-]/g, "_") || "custom_filter"
  return `// 这是受信任管理员维护的 Custom Filter；它运行在插件进程中。
// 正文由系统注入 text，固定参数从 params 读取。
export function createFilters({ framework } = {}) {
  return [{
    id: "${id}",
    displayName: "我的代码过滤器",
    description: "按自己的规则处理消息正文。",
    stages: ${JSON.stringify(stagesFromBuilder(builder))},
    effects: ["${builder.effect === "delivery" ? "delivery" : builder.effect === "network" ? "network" : "pure"}"],
    parameters: { type: "object", properties: {} },
    async apply({ text, params = {} }, context = {}) {
      const current = String(text || "")
      const nextText = current.replace(/示例词/g, "替换后的文字")

      // 简单改写可以直接返回文本，也支持 return { kind: "text", text: nextText }。
      return { kind: "text", text: nextText }

      // 如需阻止当前消息继续处理，可改为：
      // return { kind: "block", reason: "命中自定义规则" }
    },
  }]
}
`
}

export function customFilterTestDraft(source: unknown, builder: UnknownRecord = {}): UnknownRecord {
  const valuesFromRows = (items: BuilderRow[]): UnknownRecord => Object.fromEntries(items
    .filter(row => row.name?.trim())
    .map(row => [row.name.trim(), row.defaultValue !== "" ? valueFor(row) : exampleValue(row.type)]))
  const params = valuesFromRows(rows(builder.parameters).filter(row => row.name.trim() !== "text"))
  const runtimeConfig = valuesFromRows(rows(builder.runtimeFields))
  for (const key of sourceKeys(source, [/\bparams\??\.([A-Za-z_$][\w$]*)/g, /\bparams\[['"]([^'"]+)['"]\]/g])) if (!(key in params)) params[key] = ""
  for (const key of sourceKeys(source, [/\bcontext\.filterConfig\??\.([A-Za-z_$][\w$]*)/g, /\bcontext\.filterConfig\[['"]([^'"]+)['"]\]/g])) if (!(key in runtimeConfig)) runtimeConfig[key] = ""
  return { params, runtimeConfig }
}
