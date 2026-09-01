// 纯函数工具：无 DOM、无副作用，供组件与 store 复用。
// 注意：Vue 模板默认转义插值，因此不再需要 escapeHtml。

export function splitNames(value: unknown = ""): string[] {
  return String(value).split(",").map(item => item.trim()).filter(Boolean)
}

export function splitTokens(value: unknown = ""): string[] {
  return String(value).split(/[\n,，\s]+/).map(item => item.trim()).filter(Boolean)
}

export function parseJsonText<T = unknown>(raw: unknown = "", label = "JSON", fallback = {} as T): T {
  const text = String(raw || "").trim()
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch (err) {
    throw new Error(`${label} 格式错误：${err instanceof Error ? err.message : String(err)}`)
  }
}

export function toJson(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value ?? {}, null, space)
  } catch {
    return ""
  }
}

export function shortId(value: unknown = "", length = 8): string {
  return String(value || "").slice(0, length)
}

export function shortTime(value: unknown = ""): string {
  return String(value || "").slice(0, 19)
}

export function percent(ratio: unknown = 0): string {
  return `${Math.round((Number(ratio) || 0) * 100)}%`
}

// 分页：纯计算，组件用它驱动 Pager。
export interface PaginationSlice {
  current: number
  pages: number
  pageSize: number
  start: number
  end: number
}

export function paginate(total: unknown = 0, page: unknown = 1, pageSize: unknown = 8): PaginationSlice {
  const totalValue = Math.max(0, Number(total) || 0)
  const safeSize = Math.max(1, Number(pageSize) || 8)
  const pages = Math.max(1, Math.ceil(totalValue / safeSize))
  const current = Math.min(Math.max(1, Number(page) || 1), pages)
  return {
    current,
    pages,
    pageSize: safeSize,
    start: (current - 1) * safeSize,
    end: Math.min(current * safeSize, totalValue),
  }
}

export function groupBy<T>(items: T[] = [], pick: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const key = pick(item)
    ;(acc[key] ||= []).push(item)
    return acc
  }, {})
}
