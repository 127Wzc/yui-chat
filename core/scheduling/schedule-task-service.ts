import path from "node:path"
import { dataDir } from "../../config/store.js"
import { AtomicJsonRepository } from "../storage/atomic-json-repository.js"
import { hostRuntime } from "../runtime/host-runtime.js"
import { convertCQCodes } from "../message/cq-code.js"

type UnknownRecord = Record<string, unknown>

interface ScheduleEvent extends UnknownRecord {
  isGroup?: boolean
  group_id?: unknown
  user_id?: unknown
  sender?: UnknownRecord
}

interface TaskRow extends UnknownRecord {
  id?: unknown
  scopeType?: unknown
  groupId?: unknown
  userId?: unknown
  content?: unknown
  runAtMs?: unknown
  runAt?: unknown
  createdAt?: unknown
  cron?: unknown
  lastRunMinute?: unknown
  failedAt?: unknown
  attempts?: unknown
  nextAttemptAtMs?: unknown
  nextAttemptAt?: unknown
  lastAttemptAt?: unknown
  lastDeliveredAt?: unknown
  lastFailedAt?: unknown
}

interface TaskStore {
  oneTime: TaskRow[]
  cron: TaskRow[]
}

interface ScheduleConfig {
  enabled: boolean
  maxPerUser: number
  cronMaxPerUser: number
  maxDelayMinutes: number
  cronMinIntervalMinutes: number
  tickMs: number
}

interface ScheduleRepository {
  load(): Promise<TaskStore>
  update(mutator: (current: TaskStore) => TaskStore | void | Promise<TaskStore | void>): Promise<TaskStore>
}

interface SendTarget {
  sendMsg?: (payload: unknown) => Promise<unknown> | unknown
}

interface ScheduleBot {
  pickGroup?: (id: number, noCache?: boolean) => Promise<SendTarget | null> | SendTarget | null
  pickUser?: (id: number, noCache?: boolean) => Promise<SendTarget | null> | SendTarget | null
  pickFriend?: (id: number, noCache?: boolean) => Promise<SendTarget | null> | SendTarget | null
}

interface ScheduleServiceOptions {
  repository?: ScheduleRepository
  sender?: (row: TaskRow, config: unknown) => Promise<void>
  clock?: () => number
}

interface CronParts {
  raw: string
  minute: Set<number> | null
  hour: Set<number> | null
  day: Set<number> | null
  month: Set<number> | null
  weekday: Set<number> | null
  minuteField: string
  hourField: string
}

const taskFile = path.join(dataDir, "scheduled-tasks.json")
const deliveryMaxAttempts = 3
const deliveryRetryDelaysMs = [60_000, 5 * 60_000]

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function numberValue(value: unknown, fallback = 0): number {
  const result = Number(value)
  return Number.isFinite(result) ? result : fallback
}

function nowMs(): number {
  return Date.now()
}

function userId(e: ScheduleEvent = {}): string {
  return text(e.user_id || e.sender?.user_id)
}

function scopeFromEvent(e: ScheduleEvent = {}): { type: "group" | "private"; groupId: string; userId: string } {
  return {
    type: e.isGroup ? "group" : "private",
    groupId: e.isGroup ? text(e.group_id) : "",
    userId: userId(e),
  }
}

function shortId(prefix = "task"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function scheduleConfig(config: unknown = {}): ScheduleConfig {
  const cfg = record(record(record(config).tools).builtin)
  const schedule = record(cfg.scheduleTask)
  return {
    enabled: schedule.enabled !== false,
    maxPerUser: Math.max(1, Math.min(numberValue(schedule.maxPerUser, 1) || 1, 20)),
    cronMaxPerUser: Math.max(1, Math.min(numberValue(schedule.cronMaxPerUser, 1) || 1, 20)),
    maxDelayMinutes: Math.max(1, Math.min(numberValue(schedule.maxDelayMinutes, 43200) || 43200, 43200)),
    cronMinIntervalMinutes: Math.max(1, Math.min(numberValue(schedule.cronMinIntervalMinutes, 60) || 60, 1440)),
    tickMs: Math.max(10000, Math.min(numberValue(schedule.tickMs, 60000) || 60000, 300000)),
  }
}

function normalizeStore(store: unknown = {}): TaskStore {
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("定时任务文件必须是 JSON 对象")
  const value = store as UnknownRecord
  return {
    oneTime: Array.isArray(value.oneTime) ? value.oneTime.filter(item => item && typeof item === "object" && !Array.isArray(item)) as TaskRow[] : [],
    cron: Array.isArray(value.cron) ? value.cron.filter(item => item && typeof item === "object" && !Array.isArray(item)) as TaskRow[] : [],
  }
}

const taskRepository: ScheduleRepository = new AtomicJsonRepository<TaskStore>({
  file: taskFile,
  defaultValue: normalizeStore(),
  normalize: normalizeStore,
  serialize: value => JSON.stringify(value, null, 2),
  onReadError(error) {
    hostRuntime.logger?.warn?.("[yui-chat] 读取定时任务失败，损坏文件已隔离并使用空任务列表", error)
  },
})

function cronValues(field: unknown = "*", min: number, max: number): Set<number> | null {
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

function parseCron(expression: unknown = ""): CronParts {
  const fields = text(expression).trim().split(/\s+/)
  if (fields.length !== 5) throw new Error("cron 表达式需要 5 段：分 时 日 月 周。")
  return {
    raw: fields.join(" "),
    minute: cronValues(fields[0], 0, 59),
    hour: cronValues(fields[1], 0, 23),
    day: cronValues(fields[2], 1, 31),
    month: cronValues(fields[3], 1, 12),
    weekday: cronValues(fields[4], 0, 7),
    minuteField: fields[0],
    hourField: fields[1],
  }
}

function matchesCron(task: TaskRow, date = new Date()): boolean {
  let cron: CronParts
  try {
    cron = parseCron(task.cron)
  } catch {
    // 非法的持久化 cron 只跳过本轮，列表和取消仍可正常工作。
    return false
  }
  const minute = date.getMinutes()
  const hour = date.getHours()
  const day = date.getDate()
  const month = date.getMonth() + 1
  const weekday = date.getDay()
  const weekdayAlt = weekday === 0 ? 7 : weekday
  const has = (set: Set<number> | null, value: number, alt?: number) => !set || set.has(value) || (alt !== undefined && set.has(alt))
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

function estimateCronIntervalMinutes(expression: unknown = ""): number {
  const cron = parseCron(expression)
  if (!cron.minute) return 1
  const minuteGap = minCircularGap([...cron.minute], 60)
  if (minuteGap < 60) return minuteGap
  if (!cron.hour) return 60
  return minCircularGap([...cron.hour], 24) * 60
}

function visibleTask(row: TaskRow): UnknownRecord {
  const attempts = Math.max(0, numberValue(row.attempts, 0))
  const status = row.failedAt ? "failed" : attempts > 0 ? "retrying" : "pending"
  return {
    id: row.id,
    scopeType: row.scopeType,
    groupId: row.groupId,
    userId: row.userId,
    content: row.content,
    runAt: row.runAt,
    cron: row.cron,
    createdAt: row.createdAt,
    status,
    attempts,
    maxAttempts: deliveryMaxAttempts,
    nextAttemptAt: row.nextAttemptAt || "",
    failedAt: row.failedAt || "",
  }
}

function oneTimeDueAt(row: TaskRow): number {
  if (row.failedAt) return Number.POSITIVE_INFINITY
  return numberValue(row.nextAttemptAtMs || row.runAtMs, 0)
}

function markOneTimeFailure(row: TaskRow, currentTime: number): void {
  const attempts = Math.max(0, numberValue(row.attempts, 0)) + 1
  const failedAt = new Date(currentTime).toISOString()
  row.attempts = attempts
  row.lastAttemptAt = failedAt
  if (attempts >= deliveryMaxAttempts) {
    row.failedAt = failedAt
    delete row.nextAttemptAt
    delete row.nextAttemptAtMs
    return
  }
  const retryAtMs = currentTime + (deliveryRetryDelaysMs[attempts - 1] || deliveryRetryDelaysMs.at(-1) || 0)
  row.nextAttemptAtMs = retryAtMs
  row.nextAttemptAt = new Date(retryAtMs).toISOString()
}

/** 定时任务的宿主投递适配器；任务存储和 cron 状态机不直接依赖 Yunzai 全局对象。 */
export async function sendTaskMessage(row: TaskRow, config: unknown = {}): Promise<void> {
  const bot = hostRuntime.bot as unknown as ScheduleBot | undefined
  const response = record(record(config).response)
  const content = convertCQCodes(text(row.content), { removeUnsupported: response.removeCQCode !== false })
  if (row.scopeType === "group") {
    const group = await bot?.pickGroup?.(Number(row.groupId), true)
    if (!group?.sendMsg) throw new Error(`无法获取群 ${text(row.groupId)}`)
    const at = typeof hostRuntime.segment?.at === "function" ? hostRuntime.segment.at(Number(row.userId)) : `@${text(row.userId)}`
    await group.sendMsg([at, "\n定时提醒：", ...(Array.isArray(content) ? content : [content])])
    return
  }
  const user = await bot?.pickUser?.(Number(row.userId), true) || await bot?.pickFriend?.(Number(row.userId), true)
  if (!user?.sendMsg) throw new Error(`无法获取用户 ${text(row.userId)}`)
  await user.sendMsg(["定时提醒：", ...(Array.isArray(content) ? content : [content])])
}

export class ScheduleTaskService {
  timer: ReturnType<typeof setInterval> | null = null
  config: unknown = null
  store: TaskStore = normalizeStore()
  loaded = false
  running = false
  private readonly repository: ScheduleRepository
  private readonly sender: (row: TaskRow, config: unknown) => Promise<void>
  private readonly clock: () => number

  constructor(opts: ScheduleServiceOptions = {}) {
    this.repository = opts.repository || taskRepository
    this.sender = opts.sender || sendTaskMessage
    this.clock = opts.clock || nowMs
  }

  async load(): Promise<TaskStore> {
    if (this.loaded) return this.store
    this.store = await this.repository.load()
    this.loaded = true
    return this.store
  }

  async updateStore(mutator: (current: TaskStore) => TaskStore | void | Promise<TaskStore | void>): Promise<TaskStore> {
    this.store = await this.repository.update(mutator)
    this.loaded = true
    return this.store
  }

  start(config: unknown = {}): UnknownRecord {
    this.config = config
    const cfg = scheduleConfig(config)
    if (!cfg.enabled) {
      this.stop()
      return { enabled: false, tasks: this.store.oneTime.length, cron: this.store.cron.length }
    }
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.tick().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 定时任务执行失败", error))
    }, cfg.tickMs)
    this.timer.unref?.()
    this.tick().catch(error => hostRuntime.logger?.warn?.("[yui-chat] 定时任务启动检查失败", error))
    return { enabled: true, intervalMs: cfg.tickMs, tasks: this.store.oneTime.length, cron: this.store.cron.length }
  }

  stop(): UnknownRecord {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.stats()
  }

  stats(): UnknownRecord {
    return {
      enabled: Boolean(this.timer),
      oneTime: this.store.oneTime.length,
      cron: this.store.cron.length,
    }
  }

  async tick(date = new Date()): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.load()
      const currentTime = date.getTime()
      const due = this.store.oneTime.filter(row => oneTimeDueAt(row) <= currentTime)
      for (const row of due) {
        const delivered = await this.deliver(row)
        await this.updateStore(store => {
          const index = store.oneTime.findIndex(item => item.id === row.id)
          if (index < 0) return
          if (delivered) store.oneTime.splice(index, 1)
          else markOneTimeFailure(store.oneTime[index], currentTime)
        })
      }

      const minuteKey = date.toISOString().slice(0, 16)
      const cronDue = this.store.cron.filter(row => text(row.lastRunMinute) !== minuteKey && matchesCron(row, date))
      for (const row of cronDue) {
        const delivered = await this.deliver(row)
        await this.updateStore(store => {
          const current = store.cron.find(item => item.id === row.id)
          if (!current) return
          current.lastRunMinute = minuteKey
          const attemptedAt = date.toISOString()
          if (delivered) current.lastDeliveredAt = attemptedAt
          else current.lastFailedAt = attemptedAt
        })
      }
    } finally {
      this.running = false
    }
  }

  async deliver(row: TaskRow): Promise<boolean> {
    try {
      await this.sender(row, this.config || {})
      hostRuntime.logger?.mark?.(`[yui-chat] 已发送定时提醒 ${text(row.id)}`)
      return true
    } catch (error) {
      hostRuntime.logger?.warn?.(`[yui-chat] 定时提醒发送失败 ${text(row.id)}`, error)
      return false
    }
  }

  async addOneTime(e: ScheduleEvent = {}, args: UnknownRecord = {}, config: unknown = this.config || {}): Promise<string> {
    await this.load()
    const cfg = scheduleConfig(config)
    if (!cfg.enabled) return "定时任务未启用。"
    const content = text(args.content).trim().slice(0, 300)
    if (!content) return "缺少提醒内容。"
    const requestedDelay = Number(args.delayMinutes)
    if (!Number.isFinite(requestedDelay) || requestedDelay <= 0) return "delayMinutes 必须是正数。"
    const delayMinutes = Math.min(requestedDelay, cfg.maxDelayMinutes)
    const scope = scopeFromEvent(e)
    const createdAtMs = this.clock()
    const runAtMs = createdAtMs + delayMinutes * 60 * 1000
    const row: TaskRow = {
      id: shortId("once"),
      scopeType: scope.type,
      groupId: scope.groupId,
      userId: scope.userId,
      content,
      runAtMs,
      runAt: new Date(runAtMs).toISOString(),
      createdAt: new Date(createdAtMs).toISOString(),
    }
    let result = ""
    await this.updateStore(store => {
      const count = store.oneTime.filter(item => text(item.userId) === scope.userId).length
      if (count >= cfg.maxPerUser) {
        result = `每个用户最多保留 ${cfg.maxPerUser} 个一次性定时任务。`
        return
      }
      store.oneTime.push(row)
      result = `已创建定时提醒 ${text(row.id)}，将在 ${text(row.runAt)} 触发。`
    })
    return result
  }

  async addCron(e: ScheduleEvent = {}, args: UnknownRecord = {}, config: unknown = this.config || {}): Promise<string> {
    await this.load()
    const cfg = scheduleConfig(config)
    if (!cfg.enabled) return "定时任务未启用。"
    const content = text(args.content).trim().slice(0, 300)
    const cron = text(args.cron).trim()
    if (!content) return "缺少提醒内容。"
    let interval: number
    try {
      interval = estimateCronIntervalMinutes(cron)
    } catch (error) {
      return `cron 表达式无效：${text(record(error).message || error)}`
    }
    if (interval < cfg.cronMinIntervalMinutes) {
      return `cron 间隔过短：当前估算 ${interval} 分钟，最小允许 ${cfg.cronMinIntervalMinutes} 分钟。`
    }
    const scope = scopeFromEvent(e)
    const createdAtMs = this.clock()
    const row: TaskRow = {
      id: shortId("cron"),
      scopeType: scope.type,
      groupId: scope.groupId,
      userId: scope.userId,
      content,
      cron,
      createdAt: new Date(createdAtMs).toISOString(),
      lastRunMinute: "",
    }
    let result = ""
    await this.updateStore(store => {
      const count = store.cron.filter(item => text(item.userId) === scope.userId).length
      if (count >= cfg.cronMaxPerUser) {
        result = `每个用户最多保留 ${cfg.cronMaxPerUser} 个循环定时任务。`
        return
      }
      store.cron.push(row)
      result = `已创建循环提醒 ${text(row.id)}：${cron}`
    })
    return result
  }

  async list(e: ScheduleEvent = {}, type: unknown = "all"): Promise<{ oneTime: UnknownRecord[]; cron: UnknownRecord[] }> {
    await this.load()
    const uid = userId(e)
    const typeText = text(type)
    const includeOnce = typeText === "all" || typeText === "once"
    const includeCron = typeText === "all" || typeText === "cron"
    return {
      oneTime: includeOnce ? this.store.oneTime.filter(row => text(row.userId) === uid).map(visibleTask) : [],
      cron: includeCron ? this.store.cron.filter(row => text(row.userId) === uid).map(visibleTask) : [],
    }
  }

  async cancel(e: ScheduleEvent = {}, id: unknown = ""): Promise<number> {
    await this.load()
    const uid = userId(e)
    const targetId = text(id)
    let removed = 0
    await this.updateStore(store => {
      const before = store.oneTime.length + store.cron.length
      store.oneTime = store.oneTime.filter(row => !(text(row.id) === targetId && text(row.userId) === uid))
      store.cron = store.cron.filter(row => !(text(row.id) === targetId && text(row.userId) === uid))
      removed = before - store.oneTime.length - store.cron.length
    })
    return removed
  }
}

export const scheduleTaskService = new ScheduleTaskService()
