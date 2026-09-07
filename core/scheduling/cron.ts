type CronValues = Set<number> | null

export interface ParsedCronExpression {
  raw: string
  minute: CronValues
  hour: CronValues
  day: CronValues
  month: CronValues
  weekday: CronValues
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function cronValues(field: unknown = "*", min: number, max: number): CronValues {
  const input = text(field || "*").trim()
  if (input === "*") return null
  const values = new Set<number>()
  for (const part of input.split(",")) {
    const item = part.trim()
    if (!item) continue
    if (item.startsWith("*/")) {
      const step = Number(item.slice(2))
      if (!Number.isInteger(step) || step <= 0) throw new Error(`cron 字段无效：${input}`)
      for (let value = min; value <= max; value += step) values.add(value)
      continue
    }
    const range = item.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (range) {
      const start = Math.max(min, Number(range[1]))
      const end = Math.min(max, Number(range[2]))
      const step = Number(range[3] || 1)
      if (!Number.isInteger(step) || step <= 0 || start > end) throw new Error(`cron 字段无效：${input}`)
      for (let value = start; value <= end; value += step) values.add(value)
      continue
    }
    const number = Number(item)
    if (Number.isInteger(number) && number >= min && number <= max) {
      values.add(number)
      continue
    }
    throw new Error(`cron 字段无效：${input}`)
  }
  if (!values.size) throw new Error(`cron 字段无效：${input}`)
  return values
}

/** 解析五段本地时间 Cron：分 时 日 月 周。 */
export function parseCronExpression(expression: unknown = ""): ParsedCronExpression {
  const fields = text(expression).trim().split(/\s+/)
  if (fields.length !== 5 || fields.some(field => !field)) throw new Error("cron 表达式需要 5 段：分 时 日 月 周。")
  return {
    raw: fields.join(" "),
    minute: cronValues(fields[0], 0, 59),
    hour: cronValues(fields[1], 0, 23),
    day: cronValues(fields[2], 1, 31),
    month: cronValues(fields[3], 1, 12),
    weekday: cronValues(fields[4], 0, 7),
  }
}

/** 判断给定本地时间是否命中 Cron；非法表达式直接返回 false。 */
export function matchesCronExpression(expression: unknown, date = new Date()): boolean {
  let cron: ParsedCronExpression
  try {
    cron = parseCronExpression(expression)
  } catch {
    return false
  }
  const minute = date.getMinutes()
  const hour = date.getHours()
  const day = date.getDate()
  const month = date.getMonth() + 1
  const weekday = date.getDay()
  const weekdayAlt = weekday === 0 ? 7 : weekday
  const has = (set: CronValues, value: number, alternate?: number) => !set || set.has(value) || (alternate !== undefined && set.has(alternate))
  return has(cron.minute, minute)
    && has(cron.hour, hour)
    && has(cron.day, day)
    && has(cron.month, month)
    && has(cron.weekday, weekday, weekdayAlt)
}

function minCircularGap(values: readonly number[] = [], cycle: number): number {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  if (sorted.length <= 1) return cycle
  let min = cycle
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]
    const next = sorted[(index + 1) % sorted.length]
    const gap = index === sorted.length - 1 ? cycle - current + next : next - current
    if (gap > 0 && gap < min) min = gap
  }
  return min
}

/** 用于限制用户 Cron 最短触发间隔，和定时任务使用同一解析语义。 */
export function estimateCronIntervalMinutes(expression: unknown = ""): number {
  const cron = parseCronExpression(expression)
  if (!cron.minute) return 1
  const minuteGap = minCircularGap([...cron.minute], 60)
  if (minuteGap < 60) return minuteGap
  if (!cron.hour) return 60
  return minCircularGap([...cron.hour], 24) * 60
}
