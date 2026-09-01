/** 将 JSON 兼容值复制到新对象；调用方不能依赖原对象的引用身份。 */
export function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 递归冻结 JSON 结构；原始值直接返回，避免为快照引入第二套代理对象。 */
export function deepFreezeJsonValue<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJsonValue(child)
  return Object.freeze(value) as T
}
