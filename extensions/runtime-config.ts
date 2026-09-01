import { cloneJsonValue } from "../core/shared/json-values.js"
import { getToolCommon } from "../tools/support/contract.js"

type UnknownRecord = Record<string, unknown>

// secret 字段在 API/UI 中的占位值：回传该值表示保持现有密钥不变。
export const SECRET_PLACEHOLDER = "********"

function record(value: unknown): UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function schemaProperties(schema: unknown): UnknownRecord {
  return record(record(schema).properties)
}

/** 将工具声明的动态配置 Schema 收敛到 object/properties 形状。 */
export function normalizeToolConfigSchema(schema: unknown = {}): UnknownRecord {
  const value = record(schema)
  return { ...value, type: "object", properties: schemaProperties(value) }
}

/** 根据 Schema 读取默认运行变量，供执行前合并保存的覆盖项。 */
export function toolConfigDefaults(schema: unknown = {}): UnknownRecord {
  const normalized = normalizeToolConfigSchema(schema)
  const defaults = record(normalized.default)
  const result = cloneJsonValue(defaults)
  for (const [name, fieldValue] of Object.entries(schemaProperties(normalized))) {
    const field = record(fieldValue)
    if (!(name in result) && field.default !== undefined) result[name] = cloneJsonValue(field.default)
  }
  return result
}

/** 返回工具执行时的冻结运行变量；默认值与保存覆盖项只在这里合并。 */
export function resolveToolRuntimeConfig(tool: unknown = {}, config: unknown = {}): Readonly<UnknownRecord> {
  const configTools = record(record(config).tools)
  const runtimeVariables = record(configTools.runtimeVariables)
  const name = text(record(tool).name)
  const overrides = record(runtimeVariables[name])
  return Object.freeze({
    ...toolConfigDefaults(getToolCommon(tool).configSchema),
    ...cloneJsonValue(overrides),
  })
}

/** 面向 API/UI 的视图：只回显实际保存的覆盖项，secret 一律替换成占位值。 */
export function maskToolRuntimeConfig(tool: unknown = {}, overrides: unknown = {}): UnknownRecord {
  const properties = schemaProperties(normalizeToolConfigSchema(getToolCommon(tool).configSchema))
  const result: UnknownRecord = {}
  for (const [name, value] of Object.entries(record(overrides))) {
    result[name] = record(properties[name]).secret === true ? SECRET_PLACEHOLDER : cloneJsonValue(value)
  }
  return result
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** 校验工具运行变量，拒绝未声明字段，避免动态配置悄悄扩散。 */
export function validateToolRuntimeConfig(tool: unknown = {}, value: unknown = {}): UnknownRecord {
  const schema = normalizeToolConfigSchema(getToolCommon(tool).configSchema)
  const properties = schemaProperties(schema)
  const candidate = record(value)
  const issues: string[] = []
  const required = Array.isArray(schema.required) ? schema.required.map(text) : []
  for (const name of required) {
    if (candidate[name] === undefined || candidate[name] === "") issues.push(`${name} 为必填项`)
  }
  for (const [name, current] of Object.entries(candidate)) {
    const field = record(properties[name])
    if (!Object.hasOwn(properties, name)) {
      issues.push(`${name} 不是已声明的运行变量`)
      continue
    }
    const type = text(field.type)
    if (type === "boolean" && typeof current !== "boolean") issues.push(`${name} 必须是 boolean`)
    if ((type === "number" || type === "integer") && !isFiniteNumber(current)) issues.push(`${name} 必须是 number`)
    if (type === "string" && typeof current !== "string") issues.push(`${name} 必须是 string`)
    if (type === "array" && !Array.isArray(current)) issues.push(`${name} 必须是 array`)
    if (type === "object" && (!current || typeof current !== "object" || Array.isArray(current))) issues.push(`${name} 必须是 object`)
    if (Array.isArray(field.enum) && !field.enum.some(item => JSON.stringify(item) === JSON.stringify(current))) issues.push(`${name} 不在允许值范围内`)
    if (isFiniteNumber(current) && field.minimum !== undefined && current < Number(field.minimum)) issues.push(`${name} 不能小于 ${field.minimum}`)
    if (isFiniteNumber(current) && field.maximum !== undefined && current > Number(field.maximum)) issues.push(`${name} 不能大于 ${field.maximum}`)
  }
  if (issues.length) throw new Error(`${text(record(tool).name) || "扩展"} 运行变量校验失败：${issues.join("；")}`)
  return candidate
}

/** 整体替换运行变量；空值删除，secret 占位值保留旧密钥。 */
export function applyToolRuntimeConfigUpdate(tool: unknown = {}, incoming: unknown = {}, current: unknown = {}): UnknownRecord {
  const properties = schemaProperties(normalizeToolConfigSchema(getToolCommon(tool).configSchema))
  const stored = record(current)
  const next: UnknownRecord = {}
  for (const [name, value] of Object.entries(record(incoming))) {
    if (value === undefined || value === null || value === "") continue
    if (record(properties[name]).secret === true && value === SECRET_PLACEHOLDER) {
      if (stored[name] !== undefined) next[name] = stored[name]
      continue
    }
    next[name] = value
  }
  return validateToolRuntimeConfig(tool, next)
}
