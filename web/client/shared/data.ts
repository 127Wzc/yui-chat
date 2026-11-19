/**
 * 管理台所有接口数据都从 `unknown` 进入这里，再由页面按自己的数据契约收窄。
 * 这样既不会把接口返回值伪装成可信对象，也避免每个页面重复实现基础判断。
 */
export type UnknownRecord = Record<string, unknown>

/** 配置比较忽略对象字段顺序，数组顺序仍有意义。 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]))
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const a = left as UnknownRecord, b = right as UnknownRecord
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameJsonValue(a[key], b[key]))
}

export function configPath(config: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => asRecord(value)[key], config)
}

export function changedConfigPatch(patch: UnknownRecord, baseline: unknown): UnknownRecord {
  return Object.fromEntries(Object.entries(patch).filter(([path, value]) => !sameJsonValue(value, configPath(baseline, path))))
}

export function asRecord<T extends UnknownRecord = UnknownRecord>(value: unknown): T {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as T
    : {} as T
}

export function asRecords<T extends UnknownRecord = UnknownRecord>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object") as T[]
    : []
}

export function asString(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value)
}

export function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function errorMessage(error: unknown, fallback = "操作失败"): string {
  return error instanceof Error ? error.message : asString(error, fallback)
}

export function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}
