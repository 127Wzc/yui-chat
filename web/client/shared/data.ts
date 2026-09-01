/**
 * 管理台所有接口数据都从 `unknown` 进入这里，再由页面按自己的数据契约收窄。
 * 这样既不会把接口返回值伪装成可信对象，也避免每个页面重复实现基础判断。
 */
export type UnknownRecord = Record<string, unknown>

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
